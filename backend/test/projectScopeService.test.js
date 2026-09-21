import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectScopeFilter } from "../src/services/projectScopeService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// projects has its own department_id/team_lead_id columns, so it cannot reuse
// buildEmployeeScopeFilter's join-on-employee_id shape. Section 6 is silent on the exact
// predicate here; the old getScopedWorkspace callable's behavior is the only source of
// truth, confirmed intentional to carry over by D19/A8. See services/projectScopeService.js.

const DEPARTMENT = "11111111-1111-1111-1111-111111111111";
const PRINCIPAL_EMPLOYEE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const principalFor = (role) => ({
  userId: "user-id",
  employeeId: PRINCIPAL_EMPLOYEE,
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
});

test("admin and hr are unfiltered", () => {
  assert.equal(buildProjectScopeFilter(principalFor("admin")).text, "TRUE");
  assert.equal(buildProjectScopeFilter(principalFor("hr")).text, "TRUE");
});

test("manager is scoped to their department directly on the projects table, no join", () => {
  const filter = buildProjectScopeFilter(principalFor("manager"));
  assert.equal(filter.text, "projects.department_id = $1");
  assert.deepEqual(filter.values, [DEPARTMENT]);
});

test("a manager without a department is denied, not unfiltered", () => {
  const broken = { ...principalFor("manager"), departmentId: null };
  assert.equal(buildProjectScopeFilter(broken), null);
});

test("tl sees projects they lead directly, or that a team member is assigned to", () => {
  // The fuller old-callable behavior, not the minimal "own projects only" reading: D19/A8
  // frames the direct-read change as "no reason to keep that split" (same data), not
  // narrower data.
  const filter = buildProjectScopeFilter(principalFor("tl"));
  assert.match(filter.text, /projects\.team_lead_id = \$1/);
  assert.match(filter.text, /EXISTS \(/);
  assert.match(filter.text, /project_assignments/);
  assert.match(filter.text, /assignee\.team_lead_id = \$2/);
  assert.deepEqual(filter.values, [PRINCIPAL_EMPLOYEE, PRINCIPAL_EMPLOYEE]);
});

test("employee sees only projects they are assigned to, via project_assignments", () => {
  // Matches Firestore's assignedEmployeeIds array-contains exactly.
  const filter = buildProjectScopeFilter(principalFor("employee"));
  assert.match(filter.text, /EXISTS \(/);
  assert.match(filter.text, /project_assignments/);
  assert.match(filter.text, /pa\.project_id = projects\.id AND pa\.employee_id = \$1/);
  assert.deepEqual(filter.values, [PRINCIPAL_EMPLOYEE]);
});

test("every role produces a well-formed parameterised filter with no interpolated identity values", () => {
  for (const role of USER_ROLES) {
    const filter = buildProjectScopeFilter(principalFor(role));
    assert.ok(filter, `${role} must produce a filter`);
    const placeholders = new Set(filter.text.match(/\$\d+/g) ?? []);
    assert.equal(placeholders.size, filter.values.length, `${role} placeholder/value mismatch`);
    assert.doesNotMatch(filter.text, new RegExp(PRINCIPAL_EMPLOYEE));
    assert.doesNotMatch(filter.text, new RegExp(DEPARTMENT));
  }
});

test("the alias applies to every clause, including inside the EXISTS subqueries", () => {
  const managerFilter = buildProjectScopeFilter(principalFor("manager"), { alias: "p" });
  assert.equal(managerFilter.text, "p.department_id = $1");

  const tlFilter = buildProjectScopeFilter(principalFor("tl"), { alias: "p" });
  assert.match(tlFilter.text, /p\.team_lead_id = \$1/);
  assert.match(tlFilter.text, /pa\.project_id = p\.id/);

  const employeeFilter = buildProjectScopeFilter(principalFor("employee"), { alias: "p" });
  assert.match(employeeFilter.text, /pa\.project_id = p\.id/);
});

test("startParameterIndex offsets every placeholder consistently, including the two-placeholder tl case", () => {
  const managerFilter = buildProjectScopeFilter(principalFor("manager"), { startParameterIndex: 3 });
  assert.equal(managerFilter.text, "projects.department_id = $3");
  assert.equal(managerFilter.nextParameterIndex, 4);

  const tlFilter = buildProjectScopeFilter(principalFor("tl"), { startParameterIndex: 5 });
  assert.match(tlFilter.text, /\$5/);
  assert.match(tlFilter.text, /\$6/);
  assert.equal(tlFilter.nextParameterIndex, 7);

  const employeeFilter = buildProjectScopeFilter(principalFor("employee"), { startParameterIndex: 2 });
  assert.match(employeeFilter.text, /\$2/);
  assert.equal(employeeFilter.nextParameterIndex, 3);
});

test("unknown, absent and malformed principals are denied", () => {
  for (const principal of [
    null,
    undefined,
    {},
    { role: "admin" },
    { employeeId: PRINCIPAL_EMPLOYEE },
    { ...principalFor("admin"), role: "superuser" },
  ]) {
    assert.equal(buildProjectScopeFilter(principal), null, JSON.stringify(principal));
  }
});
