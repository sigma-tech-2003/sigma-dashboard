import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmployeeScopeFilter,
  getEmployeeScope,
  scopeCoversEmployee,
} from "../src/services/employeeScopeService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// Every role against every scope, per docs/schema-design.md section 6. Each expectation
// below is annotated with the docs/auth-matrix.md row it corresponds to, or with the
// decision that makes it deliberately different.

const DEPARTMENT = "11111111-1111-1111-1111-111111111111";
const OTHER_DEPARTMENT = "22222222-2222-2222-2222-222222222222";
const PRINCIPAL_EMPLOYEE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const principalFor = (role) => ({
  userId: "user-id",
  employeeId: PRINCIPAL_EMPLOYEE,
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
});

/** The employee rows every role is tested against. */
const ROWS = Object.freeze({
  self: { id: PRINCIPAL_EMPLOYEE, department_id: DEPARTMENT, team_lead_id: null },
  sameDepartmentMember: { id: "emp-1", department_id: DEPARTMENT, team_lead_id: PRINCIPAL_EMPLOYEE },
  sameDepartmentStranger: { id: "emp-2", department_id: DEPARTMENT, team_lead_id: "other-tl" },
  otherDepartment: { id: "emp-3", department_id: OTHER_DEPARTMENT, team_lead_id: null },
});

// role -> row key -> visible?  Mirrors the "employees read" row of auth-matrix.md section 3.
const VISIBILITY = Object.freeze({
  admin:    { self: true, sameDepartmentMember: true,  sameDepartmentStranger: true,  otherDepartment: true },
  hr:       { self: true, sameDepartmentMember: true,  sameDepartmentStranger: true,  otherDepartment: true },
  manager:  { self: true, sameDepartmentMember: true,  sameDepartmentStranger: true,  otherDepartment: false },
  tl:       { self: true, sameDepartmentMember: true,  sameDepartmentStranger: false, otherDepartment: false },
  employee: { self: true, sameDepartmentMember: false, sameDepartmentStranger: false, otherDepartment: false },
});

test("scope descriptors match the five roles in schema-design section 6", () => {
  assert.deepEqual(getEmployeeScope(principalFor("admin")), { type: "company" });
  assert.deepEqual(getEmployeeScope(principalFor("hr")), { type: "company" });
  assert.deepEqual(getEmployeeScope(principalFor("manager")), {
    type: "department",
    departmentId: DEPARTMENT,
  });
  assert.deepEqual(getEmployeeScope(principalFor("tl")), {
    type: "team",
    teamLeadId: PRINCIPAL_EMPLOYEE,
  });
  assert.deepEqual(getEmployeeScope(principalFor("employee")), {
    type: "self",
    employeeId: PRINCIPAL_EMPLOYEE,
  });
});

test("every role produces a parameterised filter, and admin/hr are unfiltered", () => {
  for (const role of USER_ROLES) {
    const filter = buildEmployeeScopeFilter(principalFor(role));
    assert.ok(filter, `${role} must produce a filter`);
    assert.equal(typeof filter.text, "string");
    // Placeholders and values must line up, or the query throws at execution time.
    const placeholders = new Set(filter.text.match(/\$\d+/g) ?? []);
    assert.equal(
      placeholders.size,
      new Set(filter.values.map((_, index) => `$${index + 1}`)).size,
      `${role} placeholder/value mismatch`,
    );
    // No interpolated identifiers or literals -- everything variable is a placeholder.
    assert.doesNotMatch(filter.text, new RegExp(DEPARTMENT));
    assert.doesNotMatch(filter.text, new RegExp(PRINCIPAL_EMPLOYEE));
  }

  assert.equal(buildEmployeeScopeFilter(principalFor("admin")).text, "TRUE");
  assert.equal(buildEmployeeScopeFilter(principalFor("hr")).text, "TRUE");
});

test("row visibility matches auth-matrix.md for every role and every row", () => {
  for (const role of USER_ROLES) {
    for (const [rowName, row] of Object.entries(ROWS)) {
      assert.equal(
        scopeCoversEmployee(principalFor(role), row),
        VISIBILITY[role][rowName],
        `${role} vs ${rowName}`,
      );
    }
  }
});

test("a team lead sees themselves as well as their members", () => {
  // firestore.rules:226-231 pairs the same two conditions.
  const filter = buildEmployeeScopeFilter(principalFor("tl"));
  assert.match(filter.text, /team_lead_id = \$1 OR employees\.id = \$2/);
  assert.deepEqual(filter.values, [PRINCIPAL_EMPLOYEE, PRINCIPAL_EMPLOYEE]);
});

test("a manager without a department has no scope and is denied, not unfiltered", () => {
  // The dangerous failure mode is returning "no filter" for a principal we cannot scope,
  // which would read as company-wide access.
  const broken = { ...principalFor("manager"), departmentId: null };
  assert.equal(getEmployeeScope(broken), null);
  assert.equal(buildEmployeeScopeFilter(broken), null);
});

test("unknown, absent and malformed principals are denied", () => {
  for (const principal of [
    null,
    undefined,
    {},
    { role: "admin" },
    { employeeId: PRINCIPAL_EMPLOYEE },
    { ...principalFor("admin"), role: "superuser" },
    { ...principalFor("admin"), role: "" },
  ]) {
    assert.equal(buildEmployeeScopeFilter(principal), null, JSON.stringify(principal));
    assert.equal(scopeCoversEmployee(principal, ROWS.self), false);
  }
});

test("the filter can be offset when other placeholders precede it", () => {
  const filter = buildEmployeeScopeFilter(principalFor("manager"), { startParameterIndex: 3 });
  assert.equal(filter.text, "employees.department_id = $3");
  assert.equal(filter.nextParameterIndex, 4);

  const teamFilter = buildEmployeeScopeFilter(principalFor("tl"), { startParameterIndex: 5 });
  assert.match(teamFilter.text, /\$5 OR employees\.id = \$6/);
  assert.equal(teamFilter.nextParameterIndex, 7);
});

test("the alias is applied so the predicate can be reused across joined tables", () => {
  // schema-design section 6: the same predicate applies to leaves, attendance, payroll
  // and kpis via a join on employee_id.
  const filter = buildEmployeeScopeFilter(principalFor("manager"), { alias: "e" });
  assert.equal(filter.text, "e.department_id = $1");
});

test("SQL filter and in-memory check agree for every role and row", () => {
  // These two must never diverge: one guards list queries, the other guards decisions
  // about a row already loaded. A disagreement is a privilege bug in one direction or a
  // phantom denial in the other.
  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    const filter = buildEmployeeScopeFilter(principal);
    for (const [rowName, row] of Object.entries(ROWS)) {
      const covered = scopeCoversEmployee(principal, row);
      const predicted = evaluateFilterAgainstRow(filter, row);
      assert.equal(covered, predicted, `${role} vs ${rowName}: filter and in-memory check differ`);
    }
  }
});

/** Minimal evaluator for the fragments this builder emits, used only to cross-check. */
function evaluateFilterAgainstRow(filter, row) {
  if (filter.text === "TRUE") return true;
  if (filter.text.includes("department_id")) return row.department_id === filter.values[0];
  if (filter.text.includes("team_lead_id")) {
    return row.team_lead_id === filter.values[0] || row.id === filter.values[1];
  }
  return row.id === filter.values[0];
}
