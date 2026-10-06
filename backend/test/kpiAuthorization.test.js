import assert from "node:assert/strict";
import test from "node:test";
import { assertCanWriteKpiFor, assertCanWriteKpis } from "../src/services/kpiAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level. The rules are D29: the callables' canManageProject and
// canManageLegacy, carried over. The same function is the rater's scope -- rating is authorized
// exactly like any other KPI write, and the database, not this function, refuses a self-rating or a
// rating on a legacy KPI. kpiMutationService.test.js and kpiRoutes.test.js prove it is wired in.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const TL = "tl-1";
const OTHER_TL = "tl-2";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: role === "tl" ? TL : "principal-emp",
  role,
  departmentId: DEPARTMENT,
  ...overrides,
});

/** A project as the authorization reads it. */
const project = (overrides = {}) => ({
  department_id: DEPARTMENT,
  team_lead_id: TL,
  assigneeTeamLeadIds: [TL],
  ...overrides,
});

/** The KPI's employee. */
const kpiEmployee = (overrides = {}) => ({
  id: "emp-1",
  department_id: DEPARTMENT,
  team_lead_id: TL,
  ...overrides,
});

const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};
const allowed = (principal, context) => errorOf(() => assertCanWriteKpiFor(principal, context)) === null;

// ---------------------------------------------------------------------------
// The role gate
// ---------------------------------------------------------------------------

test("assertCanWriteKpis: admin, hr, manager and tl are allowed; employee is denied", () => {
  for (const role of USER_ROLES) {
    const error = errorOf(() => assertCanWriteKpis(principalFor(role)));
    if (["admin", "hr", "manager", "tl"].includes(role)) {
      assert.equal(error, null, `${role} should be allowed`);
    } else {
      assert.equal(error?.statusCode, 403, `${role} should be denied`);
      assert.equal(error.code, "role_not_allowed", role);
      assert.match(error.message, /KPIs/);
    }
  }
});

test("assertCanWriteKpis: no employee record, or a manager/tl with no department, is denied", () => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    assert.equal(errorOf(() => assertCanWriteKpis(principalFor(role, { employeeId: null })))?.code, "role_not_allowed", role);
  }
  for (const role of ["manager", "tl"]) {
    assert.equal(errorOf(() => assertCanWriteKpis(principalFor(role, { departmentId: null })))?.code, "role_not_allowed", role);
  }
  assert.equal(errorOf(() => assertCanWriteKpis(null))?.code, "role_not_allowed");
});

// ---------------------------------------------------------------------------
// A KPI with a project
// ---------------------------------------------------------------------------

test("admin and hr may write any KPI, in any department", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(allowed(principalFor(role), { project: project(), employee: kpiEmployee() }), true, role);
    assert.equal(allowed(
      principalFor(role),
      { project: project({ department_id: OTHER_DEPARTMENT }), employee: kpiEmployee({ department_id: OTHER_DEPARTMENT, team_lead_id: null }) },
    ), true, role);
  }
});

test("manager: needs the project AND the employee in their department", () => {
  const manager = principalFor("manager");
  assert.equal(allowed(manager, { project: project(), employee: kpiEmployee() }), true);

  assert.equal(allowed(manager, { project: project({ department_id: OTHER_DEPARTMENT }), employee: kpiEmployee() }), false, "project elsewhere");
  assert.equal(allowed(manager, { project: project(), employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) }), false, "employee elsewhere");
  assert.equal(allowed(
    manager,
    { project: project({ department_id: OTHER_DEPARTMENT }), employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) },
  ), false, "both elsewhere");
});

test("manager: has no interest in the project's lead or the employee's team", () => {
  assert.equal(allowed(
    principalFor("manager"),
    { project: project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL] }), employee: kpiEmployee({ team_lead_id: OTHER_TL }) },
  ), true);
});

test("tl: needs the project in their scope AND the employee on their team", () => {
  const tl = principalFor("tl");
  assert.equal(allowed(tl, { project: project(), employee: kpiEmployee() }), true);
});

test("tl: the project is in scope when they lead it, or when any assignee reports to them", () => {
  const tl = principalFor("tl");
  const employee = kpiEmployee();
  assert.equal(allowed(tl, { project: project({ team_lead_id: TL, assigneeTeamLeadIds: [OTHER_TL] }), employee }), true, "leads it");
  assert.equal(allowed(tl, { project: project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL, TL] }), employee }), true, "has a member on it");
});

test("tl: a project that is neither theirs nor has their people is out of scope, even for an employee on their team", () => {
  assert.equal(allowed(
    principalFor("tl"),
    { project: project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL] }), employee: kpiEmployee() },
  ), false);
});

test("tl: an employee on another team is out of scope, even on a project the tl leads", () => {
  assert.equal(allowed(principalFor("tl"), { project: project(), employee: kpiEmployee({ team_lead_id: OTHER_TL }) }), false);
  assert.equal(allowed(principalFor("tl"), { project: project(), employee: kpiEmployee({ team_lead_id: null }) }), false);
});

test("tl: never reaches into another department, even a project they lead and an employee on their team", () => {
  assert.equal(allowed(
    principalFor("tl"),
    { project: project({ department_id: OTHER_DEPARTMENT }), employee: kpiEmployee() },
  ), false, "project elsewhere");
  assert.equal(allowed(
    principalFor("tl"),
    { project: project(), employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) },
  ), false, "employee elsewhere");
});

test("tl: their own employee record counts as their team (parity with canManageProject; unreachable via create, which needs an employee-role KPI employee)", () => {
  assert.equal(allowed(principalFor("tl"), { project: project(), employee: kpiEmployee({ id: TL, team_lead_id: null }) }), true);
});

test("a denied write is a 403 kpi_scope_denied", () => {
  const error = errorOf(() => assertCanWriteKpiFor(principalFor("manager"), {
    project: project({ department_id: OTHER_DEPARTMENT }), employee: kpiEmployee(),
  }));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "kpi_scope_denied");
});

// ---------------------------------------------------------------------------
// A legacy KPI (no project)
// ---------------------------------------------------------------------------

test("legacy KPI: admin and hr may write any", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(allowed(principalFor(role), { project: null, employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) }), true, role);
  }
});

test("legacy KPI: a manager needs only the employee in their department", () => {
  const manager = principalFor("manager");
  assert.equal(allowed(manager, { project: null, employee: kpiEmployee() }), true);
  assert.equal(allowed(manager, { project: null, employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) }), false);
});

test("legacy KPI: a tl needs the employee in their department and on their team", () => {
  const tl = principalFor("tl");
  assert.equal(allowed(tl, { project: null, employee: kpiEmployee() }), true);
  assert.equal(allowed(tl, { project: null, employee: kpiEmployee({ team_lead_id: OTHER_TL }) }), false);
  assert.equal(allowed(tl, { project: null, employee: kpiEmployee({ department_id: OTHER_DEPARTMENT }) }), false);
});

test("legacy KPI: the rating ban is not this function's business -- a rater in scope is authorized, and the database refuses", () => {
  // Authorization says yes for an admin over a project-less KPI. kpis_legacy_not_rateable is what
  // says no, and it must stay the thing that says no (D29): there is no legacy check here to find.
  assert.equal(allowed(principalFor("admin"), { project: null, employee: kpiEmployee() }), true);
});

test("employee, and a role the function does not know, are never allowed", () => {
  assert.equal(allowed(principalFor("employee", { employeeId: "emp-1" }), { project: project(), employee: kpiEmployee() }), false);
  assert.equal(allowed({ role: "nonsense", employeeId: "x", departmentId: DEPARTMENT }, { project: project(), employee: kpiEmployee() }), false);
});
