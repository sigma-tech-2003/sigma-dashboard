/* global __dirname, require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  KpiMutationServiceError,
  createKpiMutationService,
} = require("./kpiMutationService");

const NOW = "2026-08-22T10:00:00.000Z";
const CREATED_AT = "2026-07-01T00:00:00.000Z";
const UPDATED_AT = "2026-07-02T00:00:00.000Z";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MockFirestore {
  constructor() {
    this.data = new Map();
    this.autoId = 0;
    this.nextAutoId = null;
    this.commits = 0;
    this.unrestrictedQueries = 0;
    this.writeLog = [];
    this.failTransactionCode = null;
    this.beforeGet = null;
  }

  key(collectionName, id) {
    return `${collectionName}/${id}`;
  }

  seed(collectionName, id, value) {
    this.data.set(this.key(collectionName, String(id)), clone(value));
  }

  read(collectionName, id) {
    return clone(this.data.get(this.key(collectionName, String(id))));
  }

  collection(collectionName) {
    return {
      doc: (suppliedId) => {
        const id = suppliedId === undefined
          ? this.nextAutoId || `kpi-auto-${++this.autoId}`
          : String(suppliedId);
        this.nextAutoId = null;
        return { id, collectionName };
      },
      get: () => {
        this.unrestrictedQueries += 1;
        throw new Error("Unrestricted reads are forbidden.");
      },
      where: () => {
        this.unrestrictedQueries += 1;
        throw new Error("Queries are forbidden.");
      },
    };
  }

  async runTransaction(callback) {
    const staged = [];
    const transaction = {
      get: async (reference) => {
        if (this.beforeGet) await this.beforeGet(reference, this);
        const key = this.key(reference.collectionName, reference.id);
        return {
          exists: this.data.has(key),
          data: () => clone(this.data.get(key)),
        };
      },
      create: (reference, value) => {
        const key = this.key(reference.collectionName, reference.id);
        if (this.data.has(key) || staged.some((entry) => entry.key === key)) {
          const error = new Error("already exists");
          error.code = "already-exists";
          throw error;
        }
        staged.push({ type: "create", key, value: clone(value) });
      },
      update: (reference, value) => {
        const key = this.key(reference.collectionName, reference.id);
        if (!this.data.has(key)) {
          const error = new Error("not found");
          error.code = "not-found";
          throw error;
        }
        staged.push({ type: "update", key, value: clone(value) });
      },
      delete: (reference) => {
        staged.push({ type: "delete", key: this.key(reference.collectionName, reference.id) });
      },
    };
    const result = await callback(transaction);
    if (this.failTransactionCode) {
      const error = new Error("transaction failure");
      error.code = this.failTransactionCode;
      throw error;
    }
    staged.forEach((entry) => {
      if (entry.type === "delete") this.data.delete(entry.key);
      else if (entry.type === "update") {
        this.data.set(entry.key, { ...this.data.get(entry.key), ...clone(entry.value) });
      } else this.data.set(entry.key, clone(entry.value));
      this.writeLog.push(clone(entry));
    });
    this.commits += 1;
    return result;
  }
}

function seedPrincipal(firestore, {
  uid = "auth-user",
  id = "principal-1",
  role = "admin",
  department = "Engineering",
  status = "active",
  employeeOverrides = {},
} = {}) {
  firestore.seed("authLinks", uid, {
    employeeId: id,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
  firestore.seed("employees", id, {
    uid,
    role,
    dept: department,
    status,
    teamLeadId: null,
    name: "Principal Name",
    email: "principal@example.com",
    salary: 900000,
    ...employeeOverrides,
  });
  return { uid, id };
}

function seedEmployee(firestore, id, {
  role = "employee",
  department = "Engineering",
  status = "active",
  teamLeadId = null,
  ...extra
} = {}) {
  firestore.seed("employees", id, {
    role,
    dept: department,
    status,
    teamLeadId,
    name: `Employee ${id}`,
    email: `${id}@example.com`,
    salary: 500000,
    ...extra,
  });
}

function validProject(overrides = {}) {
  return {
    title: "Project Atlas",
    description: "Migration work",
    department: "Engineering",
    teamLeadId: "tl-1",
    assignedEmployeeIds: ["employee-1"],
    startDate: "2026-08-01",
    dueDate: "2026-09-01",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function validCreateKpi(overrides = {}) {
  return {
    projectId: "project-1",
    empId: "employee-1",
    title: "Complete migration",
    target: 40,
    current: 12,
    weight: 25,
    period: "Q3 2026",
    status: "active",
    ...overrides,
  };
}

function storedKpi(overrides = {}) {
  return {
    ...validCreateKpi(),
    rating: null,
    ratedBy: null,
    ratedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function seedProjectContext(firestore, overrides = {}) {
  const project = validProject(overrides);
  if (project.teamLeadId) seedEmployee(firestore, project.teamLeadId, { role: "tl" });
  project.assignedEmployeeIds.forEach((id) => {
    if (firestore.read("employees", id) === undefined) {
      seedEmployee(firestore, id, { teamLeadId: project.teamLeadId });
    }
  });
  firestore.seed("projects", "project-1", project);
}

function createHarness(principal = {}) {
  const firestore = new MockFirestore();
  const loggerCalls = [];
  const logger = {
    error(message, context) {
      loggerCalls.push({ message, context: clone(context) });
    },
  };
  const identity = seedPrincipal(firestore, principal);
  const service = createKpiMutationService({
    firestore,
    logger,
    clock: () => new Date(NOW),
  });
  return { firestore, loggerCalls, service, ...identity };
}

async function expectServiceError(promise, code, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KpiMutationServiceError);
    assert.equal(error.code, code);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("Admin creates a project-first KPI with normalized fields and server metadata", async () => {
  const { firestore, service, uid } = createHarness({ role: "admin" });
  seedProjectContext(firestore);

  const result = await service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi({ title: "  Complete migration  ", current: 42 }),
  });

  assert.deepEqual(result, {
    id: "kpi-auto-1",
    empId: "employee-1",
    title: "Complete migration",
    target: 40,
    current: 42,
    weight: 25,
    period: "Q3 2026",
    status: "active",
    rating: null,
    ratedBy: null,
    ratedAt: null,
    projectId: "project-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.deepEqual(firestore.read("kpis", "kpi-auto-1"), {
    projectId: "project-1",
    empId: "employee-1",
    title: "Complete migration",
    target: 40,
    current: 42,
    weight: 25,
    period: "Q3 2026",
    status: "active",
    rating: null,
    ratedBy: null,
    ratedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(Object.hasOwn(result, "percentage"), false);
  assert.equal(firestore.unrestrictedQueries, 0);
});

test("HR can create a valid company-wide KPI", async () => {
  const { firestore, service, uid } = createHarness({ role: "hr", department: "People" });
  seedEmployee(firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(firestore, "sales-employee", {
    department: "Sales",
    teamLeadId: "sales-tl",
  });
  firestore.seed("projects", "project-1", validProject({
    department: "Sales",
    teamLeadId: "sales-tl",
    assignedEmployeeIds: ["sales-employee"],
  }));

  const result = await service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi({ empId: "sales-employee" }),
  });
  assert.equal(result.empId, "sales-employee");
});

test("Manager is restricted to valid projects and employees in their department", async () => {
  const allowed = createHarness({ role: "manager" });
  seedProjectContext(allowed.firestore);
  const result = await allowed.service.manageKpi(allowed.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  });
  assert.equal(result.id, "kpi-auto-1");

  const denied = createHarness({ role: "manager" });
  seedEmployee(denied.firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(denied.firestore, "sales-employee", {
    department: "Sales",
    teamLeadId: "sales-tl",
  });
  denied.firestore.seed("projects", "project-1", validProject({
    department: "Sales",
    teamLeadId: "sales-tl",
    assignedEmployeeIds: ["sales-employee"],
  }));
  await expectServiceError(denied.service.manageKpi(denied.uid, {
    operation: "create",
    kpi: validCreateKpi({ empId: "sales-employee" }),
  }), "permission-denied", "KPI_SCOPE_DENIED");
});

test("Team Lead can manage only authorized project KPIs for their team", async () => {
  const direct = createHarness({ id: "tl-1", role: "tl" });
  seedEmployee(direct.firestore, "employee-1", { teamLeadId: "tl-1" });
  direct.firestore.seed("projects", "project-1", validProject());
  assert.equal((await direct.service.manageKpi(direct.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  })).empId, "employee-1");

  const memberProject = createHarness({ id: "tl-1", role: "tl" });
  seedEmployee(memberProject.firestore, "other-tl", { role: "tl" });
  seedEmployee(memberProject.firestore, "employee-1", { teamLeadId: "tl-1" });
  memberProject.firestore.seed("projects", "project-1", validProject({ teamLeadId: "other-tl" }));
  assert.equal((await memberProject.service.manageKpi(memberProject.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  })).id, "kpi-auto-1");

  const denied = createHarness({ id: "tl-1", role: "tl" });
  seedEmployee(denied.firestore, "other-tl", { role: "tl" });
  seedEmployee(denied.firestore, "employee-1", { teamLeadId: "other-tl" });
  denied.firestore.seed("projects", "project-1", validProject({ teamLeadId: "other-tl" }));
  await expectServiceError(denied.service.manageKpi(denied.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "permission-denied", "KPI_SCOPE_DENIED");
});

test("Employee and inactive principals cannot mutate KPIs", async () => {
  for (const principal of [
    { role: "employee", expectedReason: "ROLE_NOT_ALLOWED" },
    { role: "manager", status: "inactive", expectedReason: "PRINCIPAL_INACTIVE" },
  ]) {
    const { firestore, service, uid } = createHarness(principal);
    seedProjectContext(firestore);
    await expectServiceError(service.manageKpi(uid, {
      operation: "create",
      kpi: validCreateKpi(),
    }), "permission-denied", principal.expectedReason);
  }
});

test("Every managing role supports create, progress update, rating, and delete in valid scope", async () => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    const principal = role === "tl" ? { id: "tl-1", role } : { role };
    const { firestore, service, uid } = createHarness(principal);
    if (role === "tl") {
      seedEmployee(firestore, "employee-1", { teamLeadId: "tl-1" });
      firestore.seed("projects", "project-1", validProject());
    } else seedProjectContext(firestore);

    const created = await service.manageKpi(uid, {
      operation: "create",
      kpi: validCreateKpi(),
    });
    assert.equal((await service.manageKpi(uid, {
      operation: "update",
      kpiId: created.id,
      updates: { current: 19 },
    })).current, 19, role);
    assert.equal((await service.manageKpi(uid, {
      operation: "update",
      kpiId: created.id,
      updates: { rating: 7 },
    })).rating, 7, role);
    assert.deepEqual(await service.manageKpi(uid, {
      operation: "delete",
      kpiId: created.id,
    }), { id: created.id, deleted: true }, role);
  }
});

test("Employee is rejected for create, update, and delete", async () => {
  for (const operation of ["create", "update", "delete"]) {
    const { firestore, service, uid } = createHarness({ role: "employee" });
    seedProjectContext(firestore);
    firestore.seed("kpis", "kpi-1", storedKpi());
    const input = operation === "create"
      ? { operation, kpi: validCreateKpi() }
      : operation === "update"
        ? { operation, kpiId: "kpi-1", updates: { current: 15 } }
        : { operation, kpiId: "kpi-1" };
    await expectServiceError(
      service.manageKpi(uid, input),
      "permission-denied",
      "ROLE_NOT_ALLOWED",
    );
    assert.equal(firestore.writeLog.length, 0);
  }
});

test("Creation requires a valid project and an active assigned employee", async () => {
  const missingProject = createHarness();
  await expectServiceError(missingProject.service.manageKpi(missingProject.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "not-found", "PROJECT_NOT_FOUND");

  const notAssigned = createHarness();
  seedEmployee(notAssigned.firestore, "tl-1", { role: "tl" });
  seedEmployee(notAssigned.firestore, "employee-1");
  seedEmployee(notAssigned.firestore, "employee-2", { teamLeadId: "tl-1" });
  notAssigned.firestore.seed("projects", "project-1", validProject({
    assignedEmployeeIds: ["employee-2"],
  }));
  await expectServiceError(notAssigned.service.manageKpi(notAssigned.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "failed-precondition", "KPI_EMPLOYEE_NOT_ASSIGNED");

  const inactive = createHarness();
  seedEmployee(inactive.firestore, "tl-1", { role: "tl" });
  seedEmployee(inactive.firestore, "employee-1", { status: "inactive", teamLeadId: "tl-1" });
  inactive.firestore.seed("projects", "project-1", validProject());
  await expectServiceError(inactive.service.manageKpi(inactive.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "failed-precondition", "PROJECT_REFERENCE_INVALID");
});

test("Creation rejects malformed, protected, unknown, and projectless inputs", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  const cases = [
    { kpi: validCreateKpi({ projectId: "" }), reason: "INVALID_RELATIONSHIP_ID" },
    { kpi: { ...validCreateKpi(), percentage: 50 }, reason: "PROTECTED_KPI_FIELD" },
    { kpi: { ...validCreateKpi(), createdAt: NOW }, reason: "PROTECTED_KPI_FIELD" },
    { kpi: { ...validCreateKpi(), comment: "untrusted" }, reason: "INVALID_KPI_SCHEMA" },
  ];
  for (const item of cases) {
    await expectServiceError(service.manageKpi(uid, {
      operation: "create",
      kpi: item.kpi,
    }), "invalid-argument", item.reason);
  }
  assert.equal(firestore.writeLog.length, 0);
});

test("Target, current, weight, and status validation preserves current KPI constraints", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  const invalidCases = [
    ["target", 0],
    ["target", Number.POSITIVE_INFINITY],
    ["current", -1],
    ["current", Number.NaN],
    ["weight", 0],
    ["weight", 101],
    ["status", "paused"],
  ];
  for (const [field, value] of invalidCases) {
    await assert.rejects(service.manageKpi(uid, {
      operation: "create",
      kpi: validCreateKpi({ [field]: value }),
    }), KpiMutationServiceError);
  }
  assert.equal(firestore.writeLog.length, 0);
});

test("Numeric and string legacy relationship IDs compare canonically", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedEmployee(firestore, "9", { role: "tl" });
  seedEmployee(firestore, "7", { teamLeadId: 9 });
  firestore.seed("projects", "4", validProject({
    teamLeadId: 9,
    assignedEmployeeIds: [7],
  }));

  const result = await service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi({ projectId: 4, empId: "7" }),
  });
  assert.equal(result.projectId, "4");
  assert.equal(result.empId, "7");
});

test("Project assignment duplicates after normalization are rejected", async () => {
  const { firestore, service, uid } = createHarness();
  seedEmployee(firestore, "tl-1", { role: "tl" });
  seedEmployee(firestore, "7", { teamLeadId: "tl-1" });
  firestore.seed("projects", "project-1", validProject({ assignedEmployeeIds: [7, "7"] }));
  await expectServiceError(service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi({ empId: "7" }),
  }), "failed-precondition", "PROJECT_DATA_INVALID");
});

test("Rating updates accept only integer boundaries 1 through 10", async () => {
  for (const rating of [1, 10]) {
    const { firestore, service, uid, id } = createHarness({ role: "manager" });
    seedProjectContext(firestore);
    firestore.seed("kpis", "kpi-1", storedKpi());
    const result = await service.manageKpi(uid, {
      operation: "update",
      kpiId: "kpi-1",
      updates: { rating },
    });
    assert.equal(result.rating, rating);
    assert.equal(result.ratedBy, id);
    assert.equal(result.ratedAt, NOW);
  }

  const invalidRatings = [null, "", 0, 11, 1.5, "3.2", "nope"];
  for (const rating of invalidRatings) {
    const { firestore, service, uid } = createHarness();
    seedProjectContext(firestore);
    firestore.seed("kpis", "kpi-1", storedKpi());
    await expectServiceError(service.manageKpi(uid, {
      operation: "update",
      kpiId: "kpi-1",
      updates: { rating },
    }), "invalid-argument", "INVALID_KPI_RATING");
  }
});

test("Rating-only update preserves all unrelated KPI fields", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  const original = storedKpi({ title: "Original", current: 17, customLegacyField: "preserve" });
  firestore.seed("kpis", "kpi-1", original);

  await service.manageKpi(uid, {
    operation: "update",
    kpiId: "kpi-1",
    updates: { rating: 8 },
  });

  const stored = firestore.read("kpis", "kpi-1");
  assert.equal(stored.title, "Original");
  assert.equal(stored.current, 17);
  assert.equal(stored.customLegacyField, "preserve");
  assert.equal(stored.createdAt, CREATED_AT);
  assert.equal(stored.rating, 8);
  assert.deepEqual(Object.keys(firestore.writeLog[0].value).sort(), [
    "ratedAt",
    "ratedBy",
    "rating",
    "updatedAt",
  ]);
});

test("Progress updates preserve relationships, rating metadata, and creation time", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  firestore.seed("kpis", "kpi-1", storedKpi({
    rating: 9,
    ratedBy: "reviewer-1",
    ratedAt: UPDATED_AT,
  }));

  const result = await service.manageKpi(uid, {
    operation: "update",
    kpiId: "kpi-1",
    updates: { current: 41, weight: 30 },
  });
  assert.equal(result.current, 41);
  assert.equal(result.weight, 30);
  assert.equal(result.projectId, "project-1");
  assert.equal(result.empId, "employee-1");
  assert.equal(result.rating, 9);
  assert.equal(result.createdAt, CREATED_AT);
  assert.equal(Object.hasOwn(firestore.writeLog[0].value, "percentage"), false);
});

test("Relationship and metadata fields are immutable and rating cannot be mixed", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  firestore.seed("kpis", "kpi-1", storedKpi());
  for (const updates of [
    { empId: "employee-2" },
    { projectId: "project-2" },
    { createdAt: NOW },
    { percentage: 88 },
  ]) {
    await expectServiceError(service.manageKpi(uid, {
      operation: "update",
      kpiId: "kpi-1",
      updates,
    }), "invalid-argument", "PROTECTED_KPI_FIELD");
  }
  await expectServiceError(service.manageKpi(uid, {
    operation: "update",
    kpiId: "kpi-1",
    updates: { rating: 7, current: 20 },
  }), "invalid-argument", "INVALID_RATING_UPDATE");
});

test("Legacy KPI fallback remains scoped for update/delete but cannot be rated", async () => {
  const manager = createHarness({ role: "manager" });
  seedEmployee(manager.firestore, "employee-1");
  manager.firestore.seed("kpis", "legacy-1", storedKpi({ projectId: undefined }));
  delete manager.firestore.data.get("kpis/legacy-1").projectId;
  const updated = await manager.service.manageKpi(manager.uid, {
    operation: "update",
    kpiId: "legacy-1",
    updates: { current: 20 },
  });
  assert.equal(updated.current, 20);
  assert.equal(Object.hasOwn(updated, "projectId"), false);
  await expectServiceError(manager.service.manageKpi(manager.uid, {
    operation: "update",
    kpiId: "legacy-1",
    updates: { rating: 6 },
  }), "failed-precondition", "LEGACY_RATING_NOT_ALLOWED");

  const crossDepartment = createHarness({ role: "manager" });
  seedEmployee(crossDepartment.firestore, "sales-employee", { department: "Sales" });
  crossDepartment.firestore.seed("kpis", "legacy-2", storedKpi({
    projectId: undefined,
    empId: "sales-employee",
  }));
  delete crossDepartment.firestore.data.get("kpis/legacy-2").projectId;
  await expectServiceError(crossDepartment.service.manageKpi(crossDepartment.uid, {
    operation: "delete",
    kpiId: "legacy-2",
  }), "permission-denied", "KPI_SCOPE_DENIED");
});

test("Team Lead legacy fallback covers only self or assigned active employees", async () => {
  const allowed = createHarness({ id: "tl-1", role: "tl" });
  seedEmployee(allowed.firestore, "employee-1", { teamLeadId: "tl-1" });
  const legacy = storedKpi({ projectId: undefined });
  delete legacy.projectId;
  allowed.firestore.seed("kpis", "legacy-1", legacy);
  assert.equal((await allowed.service.manageKpi(allowed.uid, {
    operation: "update",
    kpiId: "legacy-1",
    updates: { current: 21 },
  })).current, 21);

  const denied = createHarness({ id: "tl-1", role: "tl" });
  seedEmployee(denied.firestore, "employee-1", { teamLeadId: "other-tl" });
  denied.firestore.seed("kpis", "legacy-1", legacy);
  await expectServiceError(denied.service.manageKpi(denied.uid, {
    operation: "delete",
    kpiId: "legacy-1",
  }), "permission-denied", "KPI_SCOPE_DENIED");
});

test("Latest project authorization is rechecked inside the transaction", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedProjectContext(firestore);
  firestore.seed("kpis", "kpi-1", storedKpi());
  let changed = false;
  firestore.beforeGet = async (reference, store) => {
    if (!changed && reference.collectionName === "projects") {
      changed = true;
      seedEmployee(store, "sales-tl", { role: "tl", department: "Sales" });
      seedEmployee(store, "sales-employee", { department: "Sales", teamLeadId: "sales-tl" });
      store.seed("projects", "project-1", validProject({
        department: "Sales",
        teamLeadId: "sales-tl",
        assignedEmployeeIds: ["sales-employee"],
      }));
    }
  };
  await expectServiceError(service.manageKpi(uid, {
    operation: "update",
    kpiId: "kpi-1",
    updates: { current: 30 },
  }), "failed-precondition", "KPI_EMPLOYEE_NOT_ASSIGNED");
  assert.equal(firestore.read("kpis", "kpi-1").current, 12);
});

test("Create-only conflicts and transaction failures produce no partial writes", async () => {
  const conflict = createHarness();
  seedProjectContext(conflict.firestore);
  conflict.firestore.nextAutoId = "existing-kpi";
  conflict.firestore.seed("kpis", "existing-kpi", storedKpi());
  await expectServiceError(conflict.service.manageKpi(conflict.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "already-exists", "KPI_ALREADY_EXISTS");
  assert.equal(conflict.firestore.writeLog.length, 0);

  const failed = createHarness();
  seedProjectContext(failed.firestore);
  failed.firestore.failTransactionCode = "aborted";
  await expectServiceError(failed.service.manageKpi(failed.uid, {
    operation: "create",
    kpi: validCreateKpi(),
  }), "aborted", "KPI_TRANSACTION_CONFLICT");
  assert.equal(failed.firestore.read("kpis", "kpi-auto-1"), undefined);
  assert.equal(failed.firestore.writeLog.length, 0);
});

test("Deletion removes only the selected KPI document", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  firestore.seed("kpis", "kpi-1", storedKpi());
  firestore.seed("kpis", "kpi-2", storedKpi({ title: "Keep me" }));
  firestore.seed("employees", "unrelated", { status: "active" });

  const result = await service.manageKpi(uid, { operation: "delete", kpiId: "kpi-1" });
  assert.deepEqual(result, { id: "kpi-1", deleted: true });
  assert.equal(firestore.read("kpis", "kpi-1"), undefined);
  assert.equal(firestore.read("kpis", "kpi-2").title, "Keep me");
  assert.deepEqual(firestore.read("employees", "unrelated"), { status: "active" });
});

test("Missing and conflicting principal state fails safely", async () => {
  const missingLink = createHarness();
  missingLink.firestore.data.delete(`authLinks/${missingLink.uid}`);
  await expectServiceError(missingLink.service.manageKpi(missingLink.uid, {
    operation: "delete",
    kpiId: "kpi-1",
  }), "failed-precondition", "AUTH_LINK_MISSING");

  const conflictingLink = createHarness();
  conflictingLink.firestore.seed("authLinks", conflictingLink.uid, {
    employeeId: conflictingLink.id,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    role: "admin",
  });
  await expectServiceError(conflictingLink.service.manageKpi(conflictingLink.uid, {
    operation: "delete",
    kpiId: "kpi-1",
  }), "failed-precondition", "AUTH_LINK_CONFLICT");

  const mismatchedUid = createHarness({ employeeOverrides: { uid: "different" } });
  await expectServiceError(mismatchedUid.service.manageKpi(mismatchedUid.uid, {
    operation: "delete",
    kpiId: "kpi-1",
  }), "failed-precondition", "PRINCIPAL_UID_MISMATCH");
});

test("Responses and logs contain no profiles, compensation, identities, or raw data", async () => {
  const { firestore, service, uid, loggerCalls } = createHarness();
  seedProjectContext(firestore);
  const result = await service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi(),
  });
  for (const forbidden of ["salary", "email", "uid", "authLink", "employee", "percentage"]) {
    assert.equal(Object.hasOwn(result, forbidden), false);
  }

  firestore.failTransactionCode = "internal-sdk-message";
  await expectServiceError(service.manageKpi(uid, {
    operation: "update",
    kpiId: result.id,
    updates: { current: 20 },
  }), "internal", "KPI_TRANSACTION_FAILED");
  assert.deepEqual(loggerCalls.at(-1).context, {
    event: "kpi_mutation_service_failed",
    reason: "KPI_TRANSACTION_FAILED",
  });
  assert.equal(JSON.stringify(loggerCalls).includes(uid), false);
});

test("Every operation uses document reads only", async () => {
  const { firestore, service, uid } = createHarness();
  seedProjectContext(firestore);
  const created = await service.manageKpi(uid, {
    operation: "create",
    kpi: validCreateKpi(),
  });
  await service.manageKpi(uid, {
    operation: "update",
    kpiId: created.id,
    updates: { current: 15 },
  });
  await service.manageKpi(uid, { operation: "delete", kpiId: created.id });
  assert.equal(firestore.unrestrictedQueries, 0);
  assert.equal(firestore.commits, 3);
});

test("index exports exactly six callables and manageKpi accepts only UID plus picked operation data", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const callableExports = [
    ...[...indexSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*onCall/g)]
      .map((match) => match[1]),
    ...[...indexSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*manageKpiCallable/g)]
      .map((match) => match[1]),
  ];
  assert.deepEqual(callableExports, [
    "inviteEmployee",
    "linkLegacyEmployeeUid",
    "verifyAuthSession",
    "getScopedWorkspace",
    "manageProject",
    "manageKpi",
  ]);
  assert.match(indexSource, /const manageKpiCallable = onCall/);
  const callable = indexSource.slice(indexSource.indexOf("const manageKpiCallable = onCall"));
  assert.match(callable, /request\.auth\?\.uid/);
  assert.match(callable, /kpiOperationInput\(request\.data\)/);
  assert.doesNotMatch(callable, /request\.auth\?\.token/);
  assert.doesNotMatch(callable, /request\.data\?\.(role|department|employeeId|projectId|creator)/);
});
