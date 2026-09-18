import assert from "node:assert/strict";
import test from "node:test";
import { planImport, __testables } from "../src/services/firestoreImportService.js";

// Fixture-driven, no database. See docs/migration-plan.md Phase 2 and
// docs/firebase-inventory.md sections 3-4 for what each transformation reimplements.

function baseEmployee(overrides = {}) {
  return {
    name: "Sana Riaz", email: "emp@x.com", role: "employee", dept: "Engineering",
    pos: "Developer", basic: 90000, allowances: 5000, joinDate: "2022-01-01",
    status: "active", uid: "uid-emp", empId: "EMP-100",
    ...overrides,
  };
}

function baseDataset(overrides = {}) {
  return {
    employees: [{ id: "uid-emp", data: baseEmployee() }],
    departments: [{ id: "d1", data: { name: "Engineering", status: "Active", createdAt: "2020-01-01T00:00:00.000Z" } }],
    authLinks: [{ id: "uid-emp", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } }],
    projects: [], kpis: [], leaves: [], attendance: [], payroll: [],
    ...overrides,
  };
}

const conflictCategories = (plan) => plan.conflicts.map((conflict) => conflict.category);

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

test("seeds exactly one companies row, from CLI-supplied name/code", () => {
  const plan = planImport(baseDataset(), { companyName: "Acme", companyCode: "ACME" });
  assert.equal(plan.steps.companies.length, 1);
  assert.deepEqual(plan.steps.companies[0].fields, { name: "Acme", code: "ACME" });
});

test("company name/code default when not supplied", () => {
  const plan = planImport(baseDataset());
  assert.deepEqual(plan.steps.companies[0].fields, { name: "Sigma", code: "SIGMA" });
});

// ---------------------------------------------------------------------------
// employees.dept -> department_id
// ---------------------------------------------------------------------------

test("resolves employees.dept to a department by case-insensitive name", () => {
  const dataset = baseDataset({
    departments: [{ id: "d1", data: { name: "ENGINEERING", status: "Active" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.employees[0].refs.departmentId, "d1");
});

test("an unresolvable department name is a conflict, not a guess", () => {
  const dataset = baseDataset({ employees: [{ id: "uid-emp", data: baseEmployee({ dept: "Nonexistent" }) }] });
  const plan = planImport(dataset);
  assert.deepEqual(conflictCategories(plan), ["missing-department-reference"]);
});

test("two departments colliding only by case is an ambiguous reference, not a silent pick", () => {
  const dataset = baseDataset({
    departments: [
      { id: "d1", data: { name: "Sales", status: "Active" } },
      { id: "d2", data: { name: "SALES", status: "Active" } },
    ],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("ambiguous-department-name"));
});

// ---------------------------------------------------------------------------
// Split employee -> users + employees
// ---------------------------------------------------------------------------

test("splits one employee document into one users row and one employees row", () => {
  const plan = planImport(baseDataset());
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.users.length, 1);
  assert.equal(plan.steps.employees.length, 1);

  assert.deepEqual(plan.steps.users[0].fields, { email: "emp@x.com", role: "employee", status: "active" });
  const employee = plan.steps.employees[0];
  assert.equal(employee.fields.employee_number, "EMP-100");
  assert.equal(employee.fields.full_name, "Sana Riaz");
  assert.equal(employee.fields.position_title, "Developer");
  assert.equal(employee.fields.employment_status, "active");
  assert.equal(employee.fields.joined_on, "2022-01-01");
  assert.equal(employee.fields.basic, 90000);
  assert.equal(employee.fields.allowances, 5000);
});

test("employee_number is preserved verbatim from empId, not regenerated", () => {
  const dataset = baseDataset({ employees: [{ id: "uid-emp", data: baseEmployee({ empId: "EMP-LEGACY-007" }) }] });
  const plan = planImport(dataset);
  assert.equal(plan.steps.employees[0].fields.employee_number, "EMP-LEGACY-007");
});

test("an employee with no Firebase uid still gets a users row from email alone", () => {
  // D11: every account resets its password at cutover regardless, so a matched uid was
  // never load-bearing for creating the account -- only for the bijection cross-check.
  const dataset = baseDataset({
    employees: [{ id: "3", data: baseEmployee({ uid: undefined, empId: "EMP-003" }) }],
    authLinks: [],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.users.length, 1);
  assert.equal(plan.steps.employees.length, 1);
});

test("two employees sharing an email is a conflict", () => {
  const dataset = baseDataset({
    employees: [
      { id: "uid-1", data: baseEmployee({ empId: "EMP-1" }) },
      { id: "uid-2", data: baseEmployee({ empId: "EMP-2" }) },
    ],
    authLinks: [],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("duplicate-employee-email"));
});

test("a missing employee_number, name or position is a conflict, not silently dropped", () => {
  for (const field of ["empId", "name", "pos"]) {
    const dataset = baseDataset({ employees: [{ id: "uid-emp", data: baseEmployee({ [field]: "" }) }], authLinks: [] });
    const plan = planImport(dataset);
    assert.ok(plan.conflicts.length > 0, `expected a conflict when ${field} is blank`);
  }
});

// ---------------------------------------------------------------------------
// authLinks.employeeId -> employees.user_id, bijection
// ---------------------------------------------------------------------------

test("a well-formed authLink for a linked employee produces no conflict", () => {
  const plan = planImport(baseDataset());
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
});

test("an employee with a uid but no matching authLink is a conflict", () => {
  const dataset = baseDataset({ authLinks: [] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("missing-or-conflicting-auth-link"));
});

test("two authLinks targeting the same employee is a conflict (bijection violated)", () => {
  const dataset = baseDataset({
    authLinks: [
      { id: "uid-emp", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
      { id: "uid-emp-2", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
    ],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("duplicate-auth-link-target"));
});

test("an authLink whose doc id does not match the employee's uid is a conflict", () => {
  const dataset = baseDataset({
    authLinks: [{ id: "someone-else", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("auth-link-uid-conflict"));
});

test("a malformed authLink (wrong key shape) is a conflict", () => {
  const dataset = baseDataset({
    authLinks: [{ id: "uid-emp", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("malformed-auth-link"));
});

// ---------------------------------------------------------------------------
// projects.assignedEmployeeIds[] -> project_assignments, and team leads
// ---------------------------------------------------------------------------

function datasetWithProject(projectOverrides = {}, extraEmployees = []) {
  return baseDataset({
    employees: [
      { id: "uid-tl", data: baseEmployee({ name: "Bilal Ahmed", email: "tl@x.com", role: "tl", uid: "uid-tl", empId: "EMP-TL" }) },
      { id: "uid-emp", data: baseEmployee() },
      ...extraEmployees,
    ],
    authLinks: [
      { id: "uid-tl", data: { employeeId: "uid-tl", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
      { id: "uid-emp", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
    ],
    projects: [{
      id: "p1",
      data: {
        title: "Website", description: "desc", department: "Engineering", teamLeadId: "uid-tl",
        assignedEmployeeIds: ["uid-emp"], startDate: "2025-01-01", dueDate: "2025-06-01", status: "active",
        ...projectOverrides,
      },
    }],
  });
}

test("assignedEmployeeIds becomes one project_assignments row per resolved employee", () => {
  const plan = planImport(datasetWithProject());
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.projects.length, 1);
  assert.equal(plan.steps.projectAssignments.length, 1);
  assert.equal(plan.steps.projectAssignments[0].refs.projectKey, plan.steps.projects[0].key);
});

test("a project's teamLeadId resolves to the same employee key used elsewhere", () => {
  const plan = planImport(datasetWithProject());
  const teamLead = plan.steps.employees.find((employee) => employee.sourceId === "uid-tl");
  assert.equal(plan.steps.projects[0].refs.teamLeadKey, teamLead.key);
});

test("an empty assignedEmployeeIds array is a conflict, matching Firestore's own rule", () => {
  const plan = planImport(datasetWithProject({ assignedEmployeeIds: [] }));
  assert.ok(conflictCategories(plan).includes("malformed-assignment-array"));
});

test("dueDate before startDate is a conflict", () => {
  const plan = planImport(datasetWithProject({ startDate: "2025-06-01", dueDate: "2025-01-01" }));
  assert.ok(conflictCategories(plan).includes("invalid-project-dates"));
});

test("the legacy project name field is used when title is absent", () => {
  const plan = planImport(datasetWithProject({ title: undefined, name: "Legacy Title" }));
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.projects[0].fields.title, "Legacy Title");
});

// ---------------------------------------------------------------------------
// employees.teamLeadId (self-referencing, resolved in a second pass)
// ---------------------------------------------------------------------------

test("an employee's teamLeadId resolves to another employee's synthetic key", () => {
  const dataset = baseDataset({
    employees: [
      { id: "uid-tl", data: baseEmployee({ role: "tl", email: "tl@x.com", uid: "uid-tl", empId: "EMP-TL" }) },
      { id: "uid-emp", data: baseEmployee({ teamLeadId: "uid-tl" }) },
    ],
    authLinks: [
      { id: "uid-tl", data: { employeeId: "uid-tl", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
      { id: "uid-emp", data: { employeeId: "uid-emp", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } },
    ],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  const member = plan.steps.employees.find((employee) => employee.sourceId === "uid-emp");
  const lead = plan.steps.employees.find((employee) => employee.sourceId === "uid-tl");
  assert.equal(member.refs.teamLeadKey, lead.key);
});

test("an unresolvable teamLeadId is a conflict", () => {
  const dataset = baseDataset({ employees: [{ id: "uid-emp", data: baseEmployee({ teamLeadId: "ghost" }) }] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("missing-team-lead-reference"));
});

test("departments.managerId resolves against the same employees, in a second pass", () => {
  const dataset = baseDataset({
    departments: [{ id: "d1", data: { name: "Engineering", status: "Active", managerId: "uid-emp" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.departmentManagerUpdates.length, 1);
  assert.equal(plan.steps.departmentManagerUpdates[0].managerEmployeeKey, plan.steps.employees[0].key);
});

test("a department manager who works in a DIFFERENT department is a conflict, not a raw FK crash", () => {
  // Found during real-server verification: departments_manager_employee_foreign_key is
  // composite -- (manager_employee_id, id) -> employees(id, department_id) -- so a
  // department's manager must actually work in that department. Before this test the
  // planner only checked the manager resolved to SOME employee, so this reached Postgres
  // as an uncaught foreign-key violation during --apply instead of a clean conflict here.
  const dataset = baseDataset({
    employees: [{ id: "uid-emp", data: baseEmployee({ dept: "Management", uid: undefined }) }],
    departments: [
      { id: "d1", data: { name: "Management", status: "Active" } },
      { id: "d2", data: { name: "Engineering", status: "Active", managerId: "uid-emp" } },
    ],
    authLinks: [],
  });
  const plan = planImport(dataset);
  assert.deepEqual(conflictCategories(plan), ["department-manager-wrong-department"]);
  assert.equal(plan.steps.departmentManagerUpdates.length, 0);
});

// ---------------------------------------------------------------------------
// departments.status casing
// ---------------------------------------------------------------------------

test("'Active'/'Inactive' are case-folded to lowercase", () => {
  const dataset = baseDataset({
    departments: [
      { id: "d1", data: { name: "Engineering", status: "Active" } },
      { id: "d2", data: { name: "Sales", status: "INACTIVE" } },
    ],
    employees: [],
    authLinks: [],
  });
  const plan = planImport(dataset);
  assert.deepEqual(plan.steps.departments.map((department) => department.fields.status).sort(), ["active", "inactive"]);
});

test("a department status that is neither Active nor Inactive is a conflict", () => {
  const dataset = baseDataset({ departments: [{ id: "d1", data: { name: "Engineering", status: "Pending" } }], employees: [], authLinks: [] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-department-status"));
});

// ---------------------------------------------------------------------------
// payroll.month name -> 1..12
// ---------------------------------------------------------------------------

test("every one of the twelve English month names maps to the right integer", () => {
  for (let index = 0; index < 12; index += 1) {
    const monthName = [...__testables.MONTH_TO_NUMBER.keys()][index];
    assert.equal(__testables.MONTH_TO_NUMBER.get(monthName), index + 1);
  }
});

test("payroll.month resolves through the plan end to end", () => {
  const dataset = baseDataset({
    payroll: [{ id: "pr1", data: { empId: "uid-emp", month: "March", year: 2025, basic: 90000, allowances: 5000, bonus: 0, deductions: 0, tax: 2000, net: 93000, status: "processed" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.payroll[0].fields.period_month, 3);
});

test("a month name outside the exact 12 is a conflict, including a valid-looking abbreviation", () => {
  const dataset = baseDataset({
    payroll: [{ id: "pr1", data: { empId: "uid-emp", month: "Mar", year: 2025, basic: 1000, allowances: 0, bonus: 0, deductions: 0, status: "processed" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-payroll-month"));
});

test("duplicate payroll for the same employee and period is a conflict", () => {
  const row = { empId: "uid-emp", month: "March", year: 2025, basic: 90000, allowances: 0, bonus: 0, deductions: 0, status: "processed" };
  const dataset = baseDataset({ payroll: [{ id: "pr1", data: row }, { id: "pr2", data: row }] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("duplicate-payroll-period"));
});

test("a mismatched stored tax/net is an advisory, not a blocking conflict", () => {
  const dataset = baseDataset({
    payroll: [{ id: "pr1", data: { empId: "uid-emp", month: "March", year: 2025, basic: 90000, allowances: 0, bonus: 0, deductions: 0, tax: 1, net: 1, status: "processed" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, "a stale stored tax/net must not block import -- Postgres recomputes it");
  assert.ok(plan.advisories.some((advisory) => advisory.category === "payroll-recompute-mismatch"));
});

// ---------------------------------------------------------------------------
// Attendance: "" times -> NULL, and the rest of its validation
// ---------------------------------------------------------------------------

test("empty-string attendance times become null", () => {
  const dataset = baseDataset({
    attendance: [{ id: "a1", data: { empId: "uid-emp", date: "2025-01-05", status: "absent", checkIn: "", checkOut: "", notes: "" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.attendance[0].fields.check_in, null);
  assert.equal(plan.steps.attendance[0].fields.check_out, null);
});

test("a well-formed HH:MM time is preserved", () => {
  const dataset = baseDataset({
    attendance: [{ id: "a1", data: { empId: "uid-emp", date: "2025-01-05", status: "present", checkIn: "09:00", checkOut: "17:30", notes: "" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.steps.attendance[0].fields.check_in, "09:00");
  assert.equal(plan.steps.attendance[0].fields.check_out, "17:30");
});

test("a garbage time string is a conflict, not silently coerced", () => {
  const dataset = baseDataset({
    attendance: [{ id: "a1", data: { empId: "uid-emp", date: "2025-01-05", status: "present", checkIn: "9am", checkOut: "17:00", notes: "" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-attendance-time"));
});

test("absent with a check-in time set is a conflict", () => {
  const dataset = baseDataset({
    attendance: [{ id: "a1", data: { empId: "uid-emp", date: "2025-01-05", status: "absent", checkIn: "09:00", checkOut: "", notes: "" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-attendance-times-for-status"));
});

test("duplicate attendance for the same employee and day fails loudly (D9)", () => {
  const row = { empId: "uid-emp", date: "2025-01-05", status: "present", checkIn: "09:00", checkOut: "17:00", notes: "" };
  const dataset = baseDataset({ attendance: [{ id: "a1", data: row }, { id: "a2", data: row }] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("duplicate-attendance-day"));
});

// ---------------------------------------------------------------------------
// String-vs-integer legacy id tolerance
// ---------------------------------------------------------------------------

test("a numeric legacy employee reference resolves the same as its string document id", () => {
  // uid is cleared: this employee was never linked to Firebase Auth, so the bijection
  // check (covered separately above) has nothing to verify here.
  const dataset = baseDataset({
    employees: [{ id: "3", data: baseEmployee({ empId: "EMP-003", uid: undefined }) }],
    authLinks: [],
    attendance: [{ id: "a1", data: { empId: 3, date: "2025-01-05", status: "present", checkIn: "09:00", checkOut: "17:00", notes: "" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.attendance[0].refs.employeeKey, "employees:3");
});

test("a legacy numeric alias (data.id) resolves the same as the document id", () => {
  // uid is cleared: same reasoning as the test above.
  const dataset = baseDataset({
    employees: [{ id: "3", data: baseEmployee({ empId: "EMP-003", uid: undefined }) }],
    authLinks: [],
    kpis: [{ id: "k1", data: { empId: "3", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.kpis[0].refs.employeeKey, "employees:3");
});

// ---------------------------------------------------------------------------
// KPI self-rating / legacy-rating bans, pre-validated
// ---------------------------------------------------------------------------

test("a KPI rated by its own subject is a conflict, caught before it hits the CHECK constraint", () => {
  const dataset = baseDataset({
    kpis: [{ id: "k1", data: { projectId: null, empId: "uid-emp", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active", rating: 8, ratedBy: "uid-emp", ratedAt: "2025-01-01T00:00:00.000Z" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("kpi-self-rating"));
});

test("a legacy KPI (no projectId) with a rating is a conflict", () => {
  const dataset = datasetWithProject();
  dataset.kpis = [{ id: "k1", data: { projectId: null, empId: "uid-emp", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active", rating: 8, ratedBy: "uid-tl", ratedAt: "2025-01-01T00:00:00.000Z" } }];
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("kpi-legacy-rating-conflict"));
});

test("a project-linked KPI rated by someone else is clean", () => {
  const dataset = datasetWithProject();
  dataset.kpis = [{ id: "k1", data: { projectId: "p1", empId: "uid-emp", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active", rating: 8, ratedBy: "uid-tl", ratedAt: "2025-01-01T00:00:00.000Z" } }];
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.equal(plan.steps.kpis[0].fields.rating, 8);
});

test("kpis.status other than 'active' is a conflict (A1: it is the only writable value)", () => {
  const dataset = baseDataset({
    kpis: [{ id: "k1", data: { projectId: null, empId: "uid-emp", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "completed" } }],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-kpi-status"));
});

// ---------------------------------------------------------------------------
// Leaves: decision_recorded split
// ---------------------------------------------------------------------------

test("a pending leave imports with decision_recorded = true and a null decision", () => {
  const dataset = baseDataset({
    leaves: [{ id: "l1", data: { empId: "uid-emp", type: "Annual", start: "2025-02-10", end: "2025-02-12", reason: "Trip", status: "pending", applied: "2025-02-01" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  const leave = plan.steps.leaves[0].fields;
  assert.equal(leave.decision_recorded, true);
  assert.equal(leave.decided_by_employee_id, null);
  assert.equal(leave.decided_at, null);
  assert.equal(plan.totals.leaveDecisionsWithoutApprover, 0);
});

test("an approved leave imports with its real status and decision_recorded = false", () => {
  const dataset = baseDataset({
    leaves: [{ id: "l1", data: { empId: "uid-emp", type: "Annual", start: "2025-02-10", end: "2025-02-12", reason: "Trip", status: "approved", applied: "2025-02-01" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  const leave = plan.steps.leaves[0].fields;
  assert.equal(leave.status, "approved", "status must be imported as-is, not discarded");
  assert.equal(leave.decision_recorded, false);
  assert.equal(leave.decided_by_employee_id, null);
  assert.equal(leave.decided_at, null);
  assert.equal(plan.totals.leaveDecisionsWithoutApprover, 1);
});

test("a rejected leave gets the same treatment as an approved one", () => {
  const dataset = baseDataset({
    leaves: [{ id: "l1", data: { empId: "uid-emp", type: "Sick", start: "2025-02-10", end: "2025-02-10", reason: "Flu", status: "rejected", applied: "2025-02-01" } }],
  });
  const plan = planImport(dataset);
  assert.equal(plan.steps.leaves[0].fields.decision_recorded, false);
  assert.equal(plan.totals.leaveDecisionsWithoutApprover, 1);
});

test("the leaveDecisionsWithoutApprover count reflects only decided leaves, not pending ones", () => {
  const dataset = baseDataset({
    leaves: [
      { id: "l1", data: { empId: "uid-emp", type: "Annual", start: "2025-01-01", end: "2025-01-01", reason: "a", status: "pending", applied: "2025-01-01" } },
      { id: "l2", data: { empId: "uid-emp", type: "Annual", start: "2025-02-01", end: "2025-02-01", reason: "b", status: "approved", applied: "2025-02-01" } },
      { id: "l3", data: { empId: "uid-emp", type: "Annual", start: "2025-03-01", end: "2025-03-01", reason: "c", status: "rejected", applied: "2025-03-01" } },
    ],
  });
  const plan = planImport(dataset);
  assert.equal(plan.totals.leaveDecisionsWithoutApprover, 2);
});

test("leaveBalances is not part of the input contract at all", () => {
  const dataset = baseDataset({ leaveBalances: [{ id: "uid-emp", data: { Annual: { t: 15, u: 0, r: 15 } } }] });
  const plan = planImport(dataset);
  // No step array exists for it, and it must not surface as an unrecognized-collection conflict.
  assert.equal(plan.steps.leaveBalances, undefined);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
});

// ---------------------------------------------------------------------------
// Malformed input, generally
// ---------------------------------------------------------------------------

test("a document missing an id or with a non-object data is a conflict", () => {
  const dataset = baseDataset({ employees: [{ id: null, data: baseEmployee() }, { id: "uid-x", data: "not-an-object" }] });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).filter((c) => c === "malformed-document").length >= 2);
});

test("two documents in the same collection sharing an id is a conflict", () => {
  const dataset = baseDataset({
    departments: [
      { id: "d1", data: { name: "Engineering", status: "Active" } },
      { id: "d1", data: { name: "Sales", status: "Active" } },
    ],
  });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("duplicate-document"));
});

test("a non-array value for a collection is a conflict, not a crash", () => {
  const dataset = baseDataset({ employees: "not-an-array" });
  const plan = planImport(dataset);
  assert.ok(conflictCategories(plan).includes("invalid-collection-input"));
});

// ---------------------------------------------------------------------------
// Idempotency, on paper: same input produces the same plan
// ---------------------------------------------------------------------------

test("planning the same dataset twice produces an identical plan", () => {
  const dataset = datasetWithProject();
  const first = planImport(dataset);
  const second = planImport(dataset);
  assert.deepEqual(first.steps, second.steps);
  assert.deepEqual(first.conflicts, second.conflicts);
  assert.deepEqual(first.totals, second.totals);
});

// ---------------------------------------------------------------------------
// --skip-orphans: downgrades missing-employee-reference only, opt-in only
// ---------------------------------------------------------------------------

/** One resolvable employee (uid-emp, from baseDataset) plus one orphaned reference per collection. */
function datasetWithOrphans() {
  return baseDataset({
    kpis: [{ id: "k1", data: { empId: "GHOST-1", title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active" } }],
    leaves: [{ id: "l1", data: { empId: "GHOST-2", type: "Annual", start: "2025-01-01", end: "2025-01-01", reason: "r", status: "pending", applied: "2025-01-01" } }],
    attendance: [{ id: "a1", data: { empId: "GHOST-1", date: "2025-01-05", status: "present", checkIn: "09:00", checkOut: "17:00", notes: "" } }],
    payroll: [{ id: "p1", data: { empId: "GHOST-3", month: "January", year: 2025, basic: 1000, allowances: 0, bonus: 0, deductions: 0, status: "processed" } }],
  });
}

test("without --skip-orphans, a missing employee reference blocks in every one of kpis, leaves, attendance and payroll", () => {
  const plan = planImport(datasetWithOrphans());
  const categories = conflictCategories(plan);
  assert.equal(categories.filter((category) => category === "missing-employee-reference").length, 4);
  assert.equal(plan.steps.kpis.length, 0);
  assert.equal(plan.steps.leaves.length, 0);
  assert.equal(plan.steps.attendance.length, 0);
  assert.equal(plan.steps.payroll.length, 0);
  assert.equal(plan.skippedOrphans.length, 0);
  assert.equal(plan.totals.skippedOrphans, 0);
});

test("skipOrphans defaults to off: passing no options, or options without the key, still blocks", () => {
  const dataset = datasetWithOrphans();
  for (const options of [undefined, {}, { companyName: "Acme" }, { skipOrphans: false }, { skipOrphans: undefined }]) {
    const plan = options === undefined ? planImport(dataset) : planImport(dataset, options);
    assert.ok(
      conflictCategories(plan).includes("missing-employee-reference"),
      `expected blocking with options=${JSON.stringify(options)}`,
    );
    assert.equal(plan.skippedOrphans.length, 0);
  }
});

test("with skipOrphans: true, all four collections skip instead of blocking, and the rows are omitted", () => {
  const plan = planImport(datasetWithOrphans(), { skipOrphans: true });
  assert.equal(conflictCategories(plan).filter((category) => category === "missing-employee-reference").length, 0);
  assert.equal(plan.steps.kpis.length, 0);
  assert.equal(plan.steps.leaves.length, 0);
  assert.equal(plan.steps.attendance.length, 0);
  assert.equal(plan.steps.payroll.length, 0);
  assert.equal(plan.skippedOrphans.length, 4);
  assert.equal(plan.totals.skippedOrphans, 4);
});

test("the skip report names the collection and the exact missing empId for every skipped record", () => {
  const plan = planImport(datasetWithOrphans(), { skipOrphans: true });
  const byCollection = Object.fromEntries(
    ["kpis", "leaves", "attendance", "payroll"].map((collection) => [
      collection,
      plan.skippedOrphans.filter((orphan) => orphan.collection === collection),
    ]),
  );
  assert.equal(byCollection.kpis.length, 1);
  assert.equal(byCollection.kpis[0].empId, "GHOST-1");
  assert.equal(byCollection.kpis[0].documentId, "k1");
  assert.equal(byCollection.leaves[0].empId, "GHOST-2");
  assert.equal(byCollection.attendance[0].empId, "GHOST-1");
  assert.equal(byCollection.payroll[0].empId, "GHOST-3");

  // Grouping by empId (what the CLI prints): GHOST-1 appears twice, across two collections.
  const countsByEmpId = new Map();
  for (const orphan of plan.skippedOrphans) {
    countsByEmpId.set(orphan.empId, (countsByEmpId.get(orphan.empId) ?? 0) + 1);
  }
  assert.equal(countsByEmpId.size, 3);
  assert.equal(countsByEmpId.get("GHOST-1"), 2);
  assert.equal(countsByEmpId.get("GHOST-2"), 1);
  assert.equal(countsByEmpId.get("GHOST-3"), 1);
});

test("skipOrphans never applies to an ambiguous employee reference -- it still blocks", () => {
  // Two employees whose legacy numeric alias both normalize to "3": genuinely ambiguous,
  // not missing, so which one is meant cannot be guessed regardless of the flag.
  const dataset = baseDataset({
    employees: [
      { id: "legacy-a", data: { ...baseEmployee({ email: "a@x.com", uid: "uid-a" }), id: 3 } },
      { id: "legacy-b", data: { ...baseEmployee({ email: "b@x.com", uid: "uid-b" }), id: 3 } },
    ],
    authLinks: [],
    kpis: [{ id: "k1", data: { empId: 3, title: "K", target: 10, current: 0, weight: 50, period: "Q1", status: "active" } }],
  });

  const plan = planImport(dataset, { skipOrphans: true });
  assert.ok(conflictCategories(plan).includes("ambiguous-employee-reference"));
  assert.equal(plan.skippedOrphans.length, 0, "an ambiguous reference must never be recorded as a skipped orphan");
});

test("skipOrphans does not extend to missing-department-reference", () => {
  const dataset = baseDataset({
    employees: [{ id: "uid-emp", data: baseEmployee({ dept: "Nonexistent" }) }],
  });
  const plan = planImport(dataset, { skipOrphans: true });
  assert.ok(conflictCategories(plan).includes("missing-department-reference"));
});

test("skipOrphans does not extend to the authLinks bijection check", () => {
  const dataset = baseDataset({ authLinks: [] });
  const plan = planImport(dataset, { skipOrphans: true });
  assert.ok(conflictCategories(plan).includes("missing-or-conflicting-auth-link"));
});

test("skipOrphans does not extend to department-manager-wrong-department", () => {
  const dataset = baseDataset({
    employees: [{ id: "uid-emp", data: baseEmployee({ dept: "Management", uid: undefined }) }],
    departments: [
      { id: "d1", data: { name: "Management", status: "Active" } },
      { id: "d2", data: { name: "Engineering", status: "Active", managerId: "uid-emp" } },
    ],
    authLinks: [],
  });
  const plan = planImport(dataset, { skipOrphans: true });
  assert.deepEqual(conflictCategories(plan), ["department-manager-wrong-department"]);
});
