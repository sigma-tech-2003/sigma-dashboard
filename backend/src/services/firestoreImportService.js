/**
 * Turns a Firestore export into a plan of Postgres rows to write. Pure -- no I/O, no
 * database. See docs/migration-plan.md Phase 2 and docs/firebase-inventory.md sections 3-4
 * for what this reimplements and why.
 *
 * Input contract, one JSON object:
 *   { employees: [], departments: [], authLinks: [], projects: [], kpis: [],
 *     leaves: [], attendance: [], payroll: [] }
 * Each collection is an array of { id, data } -- the same shape
 * functions/canonicalRelationshipMigration.js's own dataset contract uses. leaveBalances
 * is deliberately absent: the collection is dropped per decision (docs/schema-design.md
 * section 4.12), and it was already stale (ambiguity A2).
 *
 * This file reimplements the normalization/alias techniques proven in that Firebase-side
 * tool (createLookup, resolveReference) rather than importing it: functions/ is Firebase
 * source and out of scope to depend on from backend/.
 */

const COLLECTIONS = Object.freeze([
  "employees", "departments", "authLinks", "projects", "kpis", "leaves", "attendance", "payroll",
]);

const PAYROLL_MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);
const MONTH_TO_NUMBER = new Map(PAYROLL_MONTHS.map((name, index) => [name, index + 1]));

const ATTENDANCE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_TIMESTAMP_LOOSE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Mirrors normalizeDocumentId in the canonical migration: rejects path-unsafe ids. */
function isSafeDocumentId(value) {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return (
    id.length > 0
    && id === value
    && id.length <= 1500
    && id !== "."
    && id !== ".."
    && !id.includes("/")
  );
}

/** A relationship value can be the canonical string id or a legacy non-negative integer. */
function normalizeRelationshipValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return isSafeDocumentId(trimmed) ? trimmed : null;
  }
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

class ImportPlanBuilder {
  constructor() {
    this.conflicts = [];
    this.advisories = [];
    this.steps = { companies: [], departments: [], users: [], employees: [], departmentManagerUpdates: [], projects: [], projectAssignments: [], kpis: [], leaves: [], attendance: [], payroll: [] };
    this.stats = Object.fromEntries(COLLECTIONS.map((name) => [name, { scanned: 0, imported: 0 }]));
  }

  addConflict(category, collection, documentId = null, field = null, detail = null) {
    this.conflicts.push(Object.freeze({ category, collection, documentId, field, detail }));
  }

  addAdvisory(category, collection, documentId, detail) {
    this.advisories.push(Object.freeze({ category, collection, documentId, detail }));
  }
}

/** Normalizes one collection's raw array into deduped { id, data } entries. */
function normalizeCollection(dataset, collection, plan) {
  const source = dataset?.[collection];
  if (source === undefined) return [];
  if (!Array.isArray(source)) {
    plan.addConflict("invalid-collection-input", collection);
    return [];
  }
  plan.stats[collection].scanned = source.length;

  const seen = new Set();
  const documents = [];
  for (const entry of source) {
    const id = isSafeDocumentId(entry?.id) ? entry.id.trim() : null;
    if (!id || !isPlainObject(entry?.data)) {
      plan.addConflict("malformed-document", collection, entry?.id ?? null);
      continue;
    }
    if (seen.has(id)) {
      plan.addConflict("duplicate-document", collection, id);
      continue;
    }
    seen.add(id);
    documents.push({ id, data: entry.data });
  }
  return documents;
}

/**
 * Builds an alias lookup exactly like createLookup in canonicalRelationshipMigration.js:
 * every document is addressable by its own id AND, if present, its legacy data.id -- the
 * string-vs-integer tolerance retired for good once resolved to a single Postgres uuid.
 */
function buildAliasLookup(documents, collection, plan) {
  const aliasToIds = new Map();
  const register = (aliasValue, canonicalId) => {
    if (isEmpty(aliasValue)) return;
    const alias = normalizeRelationshipValue(aliasValue);
    if (!alias) return;
    if (!aliasToIds.has(alias)) aliasToIds.set(alias, new Set());
    aliasToIds.get(alias).add(canonicalId);
  };
  for (const document of documents) {
    register(document.id, document.id);
    if (Object.hasOwn(document.data, "id")) register(document.data.id, document.id);
  }
  for (const [alias, ids] of aliasToIds) {
    if (ids.size > 1) plan.addConflict("ambiguous-alias", collection, alias);
  }
  return aliasToIds;
}

function resolveAlias(lookup, value) {
  const alias = normalizeRelationshipValue(value);
  if (!alias) return { status: "malformed" };
  const ids = lookup.get(alias);
  if (!ids || ids.size === 0) return { status: "missing" };
  if (ids.size > 1) return { status: "ambiguous" };
  return { status: "resolved", id: [...ids][0] };
}

/** Case-insensitive lookup, matching Postgres's own lower(name) uniqueness. */
function buildDepartmentNameLookup(departments, plan) {
  const byLowerName = new Map();
  for (const department of departments) {
    const name = typeof department.data.name === "string" ? department.data.name.trim() : "";
    if (!name) {
      plan.addConflict("malformed-department", "departments", department.id, "name");
      continue;
    }
    const key = name.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, new Set());
    byLowerName.get(key).add(department.id);
  }
  for (const [key, ids] of byLowerName) {
    if (ids.size > 1) plan.addConflict("ambiguous-department-name", "departments", key);
  }
  return byLowerName;
}

function resolveDepartmentName(lookup, name) {
  if (typeof name !== "string" || !name.trim()) return { status: "missing" };
  const ids = lookup.get(name.trim().toLowerCase());
  if (!ids || ids.size === 0) return { status: "missing" };
  if (ids.size > 1) return { status: "ambiguous" };
  return { status: "resolved", id: [...ids][0] };
}

function normalizeStatusWord(value, allowed) {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return allowed.includes(lower) ? lower : null;
}

function normalizeAttendanceTime(value, documentId, plan) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "string" && ATTENDANCE_TIME_PATTERN.test(value)) return value;
  plan.addConflict("invalid-attendance-time", "attendance", documentId, "time", String(value));
  return undefined; // undefined marks "invalid", distinct from null ("absent")
}

// ---------------------------------------------------------------------------
// authLinks bijection -- mirrors validateAuthLinks in the canonical migration
// ---------------------------------------------------------------------------

function validateAuthLinkBijection(authLinks, employeesById, employeeAliasLookup, plan) {
  const employeeTargets = new Map();
  const linkedEmployeeIds = new Set();

  for (const link of authLinks) {
    const keys = Object.keys(link.data).sort().join(",");
    const exactShape = keys === "createdAt,employeeId,updatedAt";
    const timestampsLookValid = ISO_TIMESTAMP_LOOSE.test(link.data.createdAt ?? "")
      && ISO_TIMESTAMP_LOOSE.test(link.data.updatedAt ?? "");

    if (!exactShape || !timestampsLookValid) {
      plan.addConflict("malformed-auth-link", "authLinks", link.id);
      continue;
    }
    const resolution = resolveAlias(employeeAliasLookup, link.data.employeeId);
    if (resolution.status !== "resolved") {
      plan.addConflict("auth-link-employee-unresolved", "authLinks", link.id);
      continue;
    }
    if (!employeeTargets.has(resolution.id)) employeeTargets.set(resolution.id, []);
    employeeTargets.get(resolution.id).push(link.id);
    if (employeeTargets.get(resolution.id).length > 1) {
      plan.addConflict("duplicate-auth-link-target", "authLinks", resolution.id);
      continue;
    }
    const employee = employeesById.get(resolution.id);
    if (!employee || employee.data.uid !== link.id) {
      plan.addConflict("auth-link-uid-conflict", "authLinks", link.id);
      continue;
    }
    linkedEmployeeIds.add(resolution.id);
  }

  // Every employee that DOES claim a uid must have a matching, valid authLink. An
  // employee with no uid at all is legitimate (never linked to Firebase Auth) and needs
  // no check here -- see the note in migration-plan.md about D11: every account resets
  // its password at cutover regardless, so a matched uid was never load-bearing for the
  // credential itself, only for this data-quality cross-check.
  for (const employee of employeesById.values()) {
    if (isEmpty(employee.data.uid)) continue;
    if (!linkedEmployeeIds.has(employee.id)) {
      plan.addConflict("missing-or-conflicting-auth-link", "employees", employee.id, "uid");
    }
  }
}

// ---------------------------------------------------------------------------
// Per-collection planning
// ---------------------------------------------------------------------------

function planEmployees(documents, departmentLookup, plan) {
  const usersByEmail = new Map();
  const employeeRows = [];
  const employeeKeyOf = new Map(); // source employee id -> synthetic key

  for (const document of documents) {
    const data = document.data;
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    if (!email) {
      plan.addConflict("missing-employee-email", "employees", document.id, "email");
      continue;
    }
    const employeeNumber = typeof data.empId === "string" ? data.empId.trim() : "";
    if (!employeeNumber) {
      plan.addConflict("missing-employee-number", "employees", document.id, "empId");
      continue;
    }
    const fullName = typeof data.name === "string" ? data.name.trim() : "";
    if (!fullName) {
      plan.addConflict("missing-employee-name", "employees", document.id, "name");
      continue;
    }
    const positionTitle = typeof data.pos === "string" ? data.pos.trim() : "";
    if (!positionTitle) {
      plan.addConflict("missing-employee-position", "employees", document.id, "pos");
      continue;
    }
    const employmentStatus = normalizeStatusWord(data.status, ["active", "inactive"]);
    if (!employmentStatus) {
      plan.addConflict("invalid-employee-status", "employees", document.id, "status", String(data.status));
      continue;
    }
    const role = typeof data.role === "string" ? data.role.trim() : "";
    if (!["admin", "hr", "manager", "tl", "employee"].includes(role)) {
      plan.addConflict("invalid-employee-role", "employees", document.id, "role", role);
      continue;
    }
    const departmentResolution = resolveDepartmentName(departmentLookup, data.dept);
    if (departmentResolution.status !== "resolved") {
      plan.addConflict(
        departmentResolution.status === "ambiguous"
          ? "ambiguous-department-reference"
          : "missing-department-reference",
        "employees",
        document.id,
        "dept",
        typeof data.dept === "string" ? data.dept : String(data.dept),
      );
      continue;
    }
    const basic = Number(data.basic);
    const allowances = Number(data.allowances);
    if (!Number.isFinite(basic) || basic < 0 || !Number.isFinite(allowances) || allowances < 0) {
      plan.addConflict("invalid-employee-compensation", "employees", document.id);
      continue;
    }
    if (typeof data.joinDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.joinDate)) {
      plan.addConflict("invalid-employee-join-date", "employees", document.id, "joinDate");
      continue;
    }

    if (usersByEmail.has(email)) {
      plan.addConflict("duplicate-employee-email", "employees", document.id, "email", email);
      continue;
    }

    const userKey = `users:${email}`;
    const employeeKey = `employees:${document.id}`;
    employeeKeyOf.set(document.id, employeeKey);

    usersByEmail.set(email, {
      key: userKey,
      naturalKey: { email },
      fields: { email, role, status: employmentStatus },
    });

    employeeRows.push({
      key: employeeKey,
      sourceId: document.id,
      naturalKey: { userKey },
      refs: { userKey, departmentId: departmentResolution.id },
      // team_lead_id is resolved in a second pass once every employee key exists.
      rawTeamLeadId: data.teamLeadId,
      fields: {
        employee_number: employeeNumber,
        full_name: fullName,
        phone: typeof data.phone === "string" && data.phone.trim() ? data.phone.trim() : null,
        position_title: positionTitle,
        employment_status: employmentStatus,
        joined_on: data.joinDate,
        basic,
        allowances,
      },
    });
  }

  return { users: [...usersByEmail.values()], employees: employeeRows, employeeKeyOf };
}

function resolveEmployeeTeamLeads(employeeRows, employeeAliasLookup, employeeKeyOf, plan) {
  for (const employee of employeeRows) {
    if (isEmpty(employee.rawTeamLeadId)) continue;
    const resolution = resolveAlias(employeeAliasLookup, employee.rawTeamLeadId);
    if (resolution.status !== "resolved" || !employeeKeyOf.has(resolution.id)) {
      plan.addConflict(
        resolution.status === "ambiguous" ? "ambiguous-team-lead-reference" : "missing-team-lead-reference",
        "employees",
        employee.sourceId,
        "teamLeadId",
      );
      continue;
    }
    employee.refs.teamLeadKey = employeeKeyOf.get(resolution.id);
  }
}

/**
 * departmentOfEmployeeKey maps an employee's synthetic key back to the SOURCE department
 * id they belong to (planEmployees.refs.departmentId). This is what lets us check the
 * cross-field rule departments_manager_employee_foreign_key enforces in the database --
 * (manager_employee_id, id) -> employees(id, department_id), i.e. a department's manager
 * must actually work in that department -- BEFORE the write, not as a raw FK violation
 * during apply.
 */
function planDepartmentManagers(departments, employeeAliasLookup, employeeKeyOf, departmentOfEmployeeKey, plan) {
  const updates = [];
  for (const department of departments) {
    if (isEmpty(department.data.managerId)) continue;
    const resolution = resolveAlias(employeeAliasLookup, department.data.managerId);
    if (resolution.status !== "resolved" || !employeeKeyOf.has(resolution.id)) {
      plan.addConflict(
        resolution.status === "ambiguous" ? "ambiguous-department-manager" : "missing-department-manager",
        "departments",
        department.id,
        "managerId",
      );
      continue;
    }
    const managerEmployeeKey = employeeKeyOf.get(resolution.id);
    const managerDepartmentId = departmentOfEmployeeKey.get(managerEmployeeKey);
    if (managerDepartmentId !== department.id) {
      plan.addConflict("department-manager-wrong-department", "departments", department.id, "managerId");
      continue;
    }
    updates.push({ departmentSourceId: department.id, managerEmployeeKey });
  }
  return updates;
}

function planDepartments(documents, plan) {
  const rows = [];
  for (const document of documents) {
    const name = typeof document.data.name === "string" ? document.data.name.trim() : "";
    if (!name) continue; // already flagged by buildDepartmentNameLookup
    const status = normalizeStatusWord(document.data.status, ["active", "inactive"]);
    if (!status) {
      plan.addConflict("invalid-department-status", "departments", document.id, "status", String(document.data.status));
      continue;
    }
    rows.push({
      key: `departments:${document.id}`,
      sourceId: document.id,
      naturalKey: { name },
      fields: {
        name,
        description: typeof document.data.description === "string" ? document.data.description : null,
        status,
      },
    });
  }
  return rows;
}

function planProjects(documents, departmentLookup, employeeAliasLookup, employeeKeyOf, plan) {
  const rows = [];
  for (const document of documents) {
    const data = document.data;
    const title = typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : (typeof data.name === "string" ? data.name.trim() : "");
    if (!title) {
      plan.addConflict("missing-project-title", "projects", document.id);
      continue;
    }
    const departmentResolution = resolveDepartmentName(departmentLookup, data.department);
    if (departmentResolution.status !== "resolved") {
      plan.addConflict(
        departmentResolution.status === "ambiguous" ? "ambiguous-department-reference" : "missing-department-reference",
        "projects", document.id, "department",
      );
      continue;
    }
    if (!Array.isArray(data.assignedEmployeeIds) || data.assignedEmployeeIds.length === 0) {
      plan.addConflict("malformed-assignment-array", "projects", document.id, "assignedEmployeeIds");
      continue;
    }
    const assignedKeys = [];
    let assignmentsValid = true;
    for (const rawId of data.assignedEmployeeIds) {
      const resolution = resolveAlias(employeeAliasLookup, rawId);
      if (resolution.status !== "resolved" || !employeeKeyOf.has(resolution.id)) {
        plan.addConflict("missing-project-assignee", "projects", document.id, "assignedEmployeeIds");
        assignmentsValid = false;
        continue;
      }
      const key = employeeKeyOf.get(resolution.id);
      if (!assignedKeys.includes(key)) assignedKeys.push(key);
    }
    if (!assignmentsValid) continue;

    const status = ["draft", "active", "completed"].includes(data.status) ? data.status : null;
    if (!status) {
      plan.addConflict("invalid-project-status", "projects", document.id, "status", String(data.status));
      continue;
    }
    if (typeof data.startDate !== "string" || typeof data.dueDate !== "string"
      || Number.isNaN(Date.parse(data.startDate)) || Number.isNaN(Date.parse(data.dueDate))
      || data.dueDate < data.startDate) {
      plan.addConflict("invalid-project-dates", "projects", document.id);
      continue;
    }

    let teamLeadKey = null;
    if (!isEmpty(data.teamLeadId)) {
      const resolution = resolveAlias(employeeAliasLookup, data.teamLeadId);
      if (resolution.status !== "resolved" || !employeeKeyOf.has(resolution.id)) {
        plan.addConflict(
          resolution.status === "ambiguous" ? "ambiguous-team-lead-reference" : "missing-team-lead-reference",
          "projects", document.id, "teamLeadId",
        );
        continue;
      }
      teamLeadKey = employeeKeyOf.get(resolution.id);
    }

    rows.push({
      key: `projects:${document.id}`,
      sourceId: document.id,
      bookkeeping: { sourceCollection: "projects", sourceId: document.id },
      refs: { departmentId: departmentResolution.id, teamLeadKey, assignedEmployeeKeys: assignedKeys },
      fields: {
        title,
        description: typeof data.description === "string" ? data.description : "",
        start_date: data.startDate,
        due_date: data.dueDate,
        status,
      },
    });
  }
  return rows;
}

function planKpis(documents, employeeAliasLookup, employeeKeyOf, projectAliasLookup, projectKeyOf, plan) {
  const rows = [];
  for (const document of documents) {
    const data = document.data;
    const employeeResolution = resolveAlias(employeeAliasLookup, data.empId);
    if (employeeResolution.status !== "resolved" || !employeeKeyOf.has(employeeResolution.id)) {
      plan.addConflict(
        employeeResolution.status === "ambiguous" ? "ambiguous-employee-reference" : "missing-employee-reference",
        "kpis", document.id, "empId",
      );
      continue;
    }
    let projectKey = null;
    if (!isEmpty(data.projectId)) {
      const resolution = resolveAlias(projectAliasLookup, data.projectId);
      if (resolution.status !== "resolved" || !projectKeyOf.has(resolution.id)) {
        plan.addConflict(
          resolution.status === "ambiguous" ? "ambiguous-project-reference" : "missing-project-reference",
          "kpis", document.id, "projectId",
        );
        continue;
      }
      projectKey = projectKeyOf.get(resolution.id);
    }

    const title = typeof data.title === "string" ? data.title.trim() : "";
    const target = Number(data.target);
    const current = Number(data.current ?? 0);
    const weight = Number(data.weight);
    if (!title || !Number.isFinite(target) || target <= 0 || !Number.isFinite(current) || current < 0
      || !Number.isInteger(weight) || weight < 1 || weight > 100) {
      plan.addConflict("invalid-kpi-fields", "kpis", document.id);
      continue;
    }
    if (data.status !== "active") {
      plan.addConflict("invalid-kpi-status", "kpis", document.id, "status", String(data.status));
      continue;
    }

    let ratedByEmployeeKey = null;
    let rating = null;
    let ratedAt = null;
    if (!isEmpty(data.rating)) {
      rating = Number(data.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
        plan.addConflict("invalid-kpi-rating", "kpis", document.id, "rating");
        continue;
      }
      const ratedByResolution = resolveAlias(employeeAliasLookup, data.ratedBy);
      if (ratedByResolution.status !== "resolved" || !employeeKeyOf.has(ratedByResolution.id)) {
        plan.addConflict("missing-kpi-rater-reference", "kpis", document.id, "ratedBy");
        continue;
      }
      ratedByEmployeeKey = employeeKeyOf.get(ratedByResolution.id);
      if (ratedByEmployeeKey === employeeKeyOf.get(employeeResolution.id)) {
        plan.addConflict("kpi-self-rating", "kpis", document.id);
        continue;
      }
      if (!projectKey) {
        plan.addConflict("kpi-legacy-rating-conflict", "kpis", document.id);
        continue;
      }
      ratedAt = typeof data.ratedAt === "string" ? data.ratedAt : new Date().toISOString();
    }

    rows.push({
      key: `kpis:${document.id}`,
      sourceId: document.id,
      bookkeeping: { sourceCollection: "kpis", sourceId: document.id },
      refs: { employeeKey: employeeKeyOf.get(employeeResolution.id), projectKey, ratedByEmployeeKey },
      fields: {
        title,
        target,
        current_value: current,
        weight,
        period: typeof data.period === "string" ? data.period : "",
        rating,
        rated_at: ratedAt,
      },
    });
  }
  return rows;
}

function planLeaves(documents, employeeAliasLookup, employeeKeyOf, plan) {
  const rows = [];
  let decisionsWithoutApprover = 0;

  for (const document of documents) {
    const data = document.data;
    const employeeResolution = resolveAlias(employeeAliasLookup, data.empId);
    if (employeeResolution.status !== "resolved" || !employeeKeyOf.has(employeeResolution.id)) {
      plan.addConflict(
        employeeResolution.status === "ambiguous" ? "ambiguous-employee-reference" : "missing-employee-reference",
        "leaves", document.id, "empId",
      );
      continue;
    }
    if (!["Annual", "Sick", "Casual", "Maternity", "Emergency"].includes(data.type)) {
      plan.addConflict("invalid-leave-type", "leaves", document.id, "type", String(data.type));
      continue;
    }
    if (!["pending", "approved", "rejected"].includes(data.status)) {
      plan.addConflict("invalid-leave-status", "leaves", document.id, "status", String(data.status));
      continue;
    }
    if (typeof data.start !== "string" || typeof data.end !== "string"
      || Number.isNaN(Date.parse(data.start)) || Number.isNaN(Date.parse(data.end))
      || data.end < data.start) {
      plan.addConflict("invalid-leave-dates", "leaves", document.id);
      continue;
    }
    const reason = typeof data.reason === "string" ? data.reason.trim() : "";
    if (!reason) {
      plan.addConflict("missing-leave-reason", "leaves", document.id, "reason");
      continue;
    }
    if (typeof data.applied !== "string" || Number.isNaN(Date.parse(data.applied))) {
      plan.addConflict("invalid-leave-applied-date", "leaves", document.id, "applied");
      continue;
    }

    // Per your direction: import every leave with its real status. Firestore never
    // recorded who decided or when, so a decided leave gets decision_recorded = false and
    // both fields left null -- see migrations/003_leave_decision_provenance.
    const decisionRecorded = false; // the importer never has a real approver to attribute
    if (data.status !== "pending") decisionsWithoutApprover += 1;

    rows.push({
      key: `leaves:${document.id}`,
      sourceId: document.id,
      bookkeeping: { sourceCollection: "leaves", sourceId: document.id },
      refs: { employeeKey: employeeKeyOf.get(employeeResolution.id) },
      fields: {
        type: data.type,
        start_date: data.start,
        end_date: data.end,
        reason,
        status: data.status,
        applied_on: data.applied,
        decided_by_employee_id: null,
        decided_at: null,
        decision_recorded: data.status === "pending" ? true : decisionRecorded,
      },
    });
  }

  return { rows, decisionsWithoutApprover };
}

function planAttendance(documents, employeeAliasLookup, employeeKeyOf, plan) {
  const rows = [];
  const seenByEmployeeDate = new Map();

  for (const document of documents) {
    const data = document.data;
    const employeeResolution = resolveAlias(employeeAliasLookup, data.empId);
    if (employeeResolution.status !== "resolved" || !employeeKeyOf.has(employeeResolution.id)) {
      plan.addConflict(
        employeeResolution.status === "ambiguous" ? "ambiguous-employee-reference" : "missing-employee-reference",
        "attendance", document.id, "empId",
      );
      continue;
    }
    if (!["present", "absent", "late", "leave"].includes(data.status)) {
      plan.addConflict("invalid-attendance-status", "attendance", document.id, "status", String(data.status));
      continue;
    }
    if (typeof data.date !== "string" || Number.isNaN(Date.parse(data.date))) {
      plan.addConflict("invalid-attendance-date", "attendance", document.id, "date");
      continue;
    }
    const checkIn = normalizeAttendanceTime(data.checkIn, document.id, plan);
    const checkOut = normalizeAttendanceTime(data.checkOut, document.id, plan);
    if (checkIn === undefined || checkOut === undefined) continue;
    if (["absent", "leave"].includes(data.status) && (checkIn !== null || checkOut !== null)) {
      plan.addConflict("invalid-attendance-times-for-status", "attendance", document.id);
      continue;
    }
    if (checkIn !== null && checkOut !== null && checkOut <= checkIn) {
      plan.addConflict("invalid-attendance-time-order", "attendance", document.id);
      continue;
    }

    const employeeKey = employeeKeyOf.get(employeeResolution.id);
    const dedupeKey = `${employeeKey}|${data.date}`;
    if (seenByEmployeeDate.has(dedupeKey)) {
      plan.addConflict("duplicate-attendance-day", "attendance", document.id, "date", data.date);
      continue;
    }
    seenByEmployeeDate.set(dedupeKey, document.id);

    rows.push({
      key: `attendance:${document.id}`,
      sourceId: document.id,
      naturalKey: { employeeKey, work_date: data.date },
      refs: { employeeKey },
      fields: {
        work_date: data.date,
        status: data.status,
        check_in: checkIn,
        check_out: checkOut,
        notes: typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : null,
      },
    });
  }
  return rows;
}

/** Recomputes the same progressive bracket as payroll_tax_for() in 001, for the advisory. */
function calculatedPayrollTax(gross) {
  if (gross <= 50000) return 0;
  if (gross <= 100000) return Math.round((gross - 50000) * 0.05);
  if (gross <= 200000) return Math.round((gross - 100000) * 0.10) + 2500;
  return Math.round((gross - 200000) * 0.15) + 12500;
}

function planPayroll(documents, employeeAliasLookup, employeeKeyOf, plan) {
  const rows = [];
  const seenByEmployeePeriod = new Map();

  for (const document of documents) {
    const data = document.data;
    const employeeResolution = resolveAlias(employeeAliasLookup, data.empId);
    if (employeeResolution.status !== "resolved" || !employeeKeyOf.has(employeeResolution.id)) {
      plan.addConflict(
        employeeResolution.status === "ambiguous" ? "ambiguous-employee-reference" : "missing-employee-reference",
        "payroll", document.id, "empId",
      );
      continue;
    }
    const periodMonth = MONTH_TO_NUMBER.get(data.month);
    if (!periodMonth) {
      plan.addConflict("invalid-payroll-month", "payroll", document.id, "month", String(data.month));
      continue;
    }
    const periodYear = Number(data.year);
    if (!Number.isInteger(periodYear) || periodYear < 1 || periodYear > 9999) {
      plan.addConflict("invalid-payroll-year", "payroll", document.id, "year");
      continue;
    }
    const basic = Number(data.basic);
    const allowances = Number(data.allowances);
    const bonus = Number(data.bonus);
    const deductions = Number(data.deductions);
    if ([basic, allowances, bonus, deductions].some((value) => !Number.isFinite(value) || value < 0)) {
      plan.addConflict("invalid-payroll-amounts", "payroll", document.id);
      continue;
    }
    if (!["draft", "processed"].includes(data.status)) {
      plan.addConflict("invalid-payroll-status", "payroll", document.id, "status", String(data.status));
      continue;
    }

    const employeeKey = employeeKeyOf.get(employeeResolution.id);
    const dedupeKey = `${employeeKey}|${periodYear}-${periodMonth}`;
    if (seenByEmployeePeriod.has(dedupeKey)) {
      plan.addConflict("duplicate-payroll-period", "payroll", document.id, "month");
      continue;
    }
    seenByEmployeePeriod.set(dedupeKey, document.id);

    const gross = basic + allowances + bonus;
    const recomputedTax = calculatedPayrollTax(gross);
    const recomputedNet = gross - deductions - recomputedTax;
    if (Number.isFinite(Number(data.tax)) && Number(data.tax) !== recomputedTax) {
      plan.addAdvisory("payroll-recompute-mismatch", "payroll", document.id, {
        field: "tax", stored: data.tax, recomputed: recomputedTax,
      });
    }
    if (Number.isFinite(Number(data.net)) && Number(data.net) !== recomputedNet) {
      plan.addAdvisory("payroll-recompute-mismatch", "payroll", document.id, {
        field: "net", stored: data.net, recomputed: recomputedNet,
      });
    }

    rows.push({
      key: `payroll:${document.id}`,
      sourceId: document.id,
      naturalKey: { employeeKey, period_year: periodYear, period_month: periodMonth },
      refs: { employeeKey },
      fields: {
        period_year: periodYear,
        period_month: periodMonth,
        basic,
        allowances,
        bonus,
        deductions,
        status: data.status,
      },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} dataset - see the module docstring for the shape.
 * @param {{ companyName?: string, companyCode?: string }} [options]
 */
export function planImport(dataset, options = {}) {
  const plan = new ImportPlanBuilder();
  const companyName = options.companyName?.trim() || "Sigma";
  const companyCode = options.companyCode?.trim() || "SIGMA";

  const employeeDocuments = normalizeCollection(dataset, "employees", plan);
  const departmentDocuments = normalizeCollection(dataset, "departments", plan);
  const authLinkDocuments = normalizeCollection(dataset, "authLinks", plan);
  const projectDocuments = normalizeCollection(dataset, "projects", plan);
  const kpiDocuments = normalizeCollection(dataset, "kpis", plan);
  const leaveDocuments = normalizeCollection(dataset, "leaves", plan);
  const attendanceDocuments = normalizeCollection(dataset, "attendance", plan);
  const payrollDocuments = normalizeCollection(dataset, "payroll", plan);

  plan.steps.companies.push({ key: "companies:singleton", naturalKey: {}, fields: { name: companyName, code: companyCode } });

  const departmentLookup = buildDepartmentNameLookup(departmentDocuments, plan);
  plan.steps.departments = planDepartments(departmentDocuments, plan);

  const employeeAliasLookup = buildAliasLookup(employeeDocuments, "employees", plan);
  const employeesById = new Map(employeeDocuments.map((document) => [document.id, document]));

  const { users, employees, employeeKeyOf } = planEmployees(employeeDocuments, departmentLookup, plan);
  plan.steps.users = users;
  plan.steps.employees = employees;

  resolveEmployeeTeamLeads(employees, employeeAliasLookup, employeeKeyOf, plan);
  const departmentOfEmployeeKey = new Map(employees.map((employee) => [employee.key, employee.refs.departmentId]));
  plan.steps.departmentManagerUpdates = planDepartmentManagers(
    departmentDocuments, employeeAliasLookup, employeeKeyOf, departmentOfEmployeeKey, plan,
  );

  validateAuthLinkBijection(authLinkDocuments, employeesById, employeeAliasLookup, plan);

  const projectAliasLookup = buildAliasLookup(projectDocuments, "projects", plan);
  plan.steps.projects = planProjects(projectDocuments, departmentLookup, employeeAliasLookup, employeeKeyOf, plan);
  const projectKeyOf = new Map(plan.steps.projects.map((project) => [project.sourceId, project.key]));

  // Materialize each project's assignedEmployeeIds into explicit junction rows, so the
  // apply step never has to re-derive them from a nested field.
  for (const project of plan.steps.projects) {
    for (const employeeKey of project.refs.assignedEmployeeKeys) {
      plan.steps.projectAssignments.push({
        key: `project_assignments:${project.sourceId}:${employeeKey}`,
        refs: { projectKey: project.key, employeeKey },
      });
    }
  }

  plan.steps.kpis = planKpis(kpiDocuments, employeeAliasLookup, employeeKeyOf, projectAliasLookup, projectKeyOf, plan);

  const leavesResult = planLeaves(leaveDocuments, employeeAliasLookup, employeeKeyOf, plan);
  plan.steps.leaves = leavesResult.rows;

  plan.steps.attendance = planAttendance(attendanceDocuments, employeeAliasLookup, employeeKeyOf, plan);
  plan.steps.payroll = planPayroll(payrollDocuments, employeeAliasLookup, employeeKeyOf, plan);

  const totals = {
    documents: COLLECTIONS.reduce((sum, name) => sum + plan.stats[name].scanned, 0),
    conflicts: plan.conflicts.length,
    advisories: plan.advisories.length,
    leaveDecisionsWithoutApprover: leavesResult.decisionsWithoutApprover,
  };

  return Object.freeze({
    conflicts: Object.freeze(plan.conflicts),
    advisories: Object.freeze(plan.advisories),
    steps: plan.steps,
    totals: Object.freeze(totals),
  });
}

export const __testables = {
  isSafeDocumentId,
  normalizeRelationshipValue,
  calculatedPayrollTax,
  MONTH_TO_NUMBER,
};
