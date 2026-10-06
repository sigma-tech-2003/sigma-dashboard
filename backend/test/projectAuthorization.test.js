import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_WRITE_ROLES,
  assertCanManageExistingProject,
  assertCanWriteProjectsOrKpis,
  assertResultingProjectInScope,
  canManageExistingProject,
} from "../src/services/projectAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level, mirroring payrollAuthorization.test.js. The rules are D29: the
// callables' policy, checked on the project as it stands AND as it would become. This file owns the
// exhaustive matrix; projectMutationService.test.js and projectRoutes.test.js prove it is wired in.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const TL = "tl-1";
const OTHER_TL = "tl-2";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: role === "tl" ? TL : "principal-emp",
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
  ...overrides,
});

/** A project as the authorization functions read it. */
const project = (overrides = {}) => ({
  department_id: DEPARTMENT,
  team_lead_id: null,
  assigneeTeamLeadIds: [],
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

// ---------------------------------------------------------------------------
// The role gate
// ---------------------------------------------------------------------------

test("assertCanWriteProjectsOrKpis: admin, hr, manager and tl are allowed; employee is denied", () => {
  for (const role of USER_ROLES) {
    const error = errorOf(() => assertCanWriteProjectsOrKpis(principalFor(role)));
    if (["admin", "hr", "manager", "tl"].includes(role)) {
      assert.equal(error, null, `${role} should be allowed`);
    } else {
      assert.equal(error?.statusCode, 403, `${role} should be denied`);
      assert.equal(error.code, "role_not_allowed", role);
    }
  }
});

test("PROJECT_WRITE_ROLES is exactly the callables' MANAGING_ROLES", () => {
  assert.deepEqual([...PROJECT_WRITE_ROLES].sort(), ["admin", "hr", "manager", "tl"]);
});

test("the gate names what the caller tried to manage in its message", () => {
  assert.match(errorOf(() => assertCanWriteProjectsOrKpis(principalFor("employee"), "projects")).message, /projects/);
  assert.match(errorOf(() => assertCanWriteProjectsOrKpis(principalFor("employee"), "KPIs")).message, /KPIs/);
});

test("a principal with no role, or none at all, is denied rather than crashed", () => {
  assert.equal(errorOf(() => assertCanWriteProjectsOrKpis({}))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWriteProjectsOrKpis(null))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWriteProjectsOrKpis(undefined))?.code, "role_not_allowed");
});

test("an account not linked to an employee record is denied, even an admin (the id becomes the deleter and the rater)", () => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    const error = errorOf(() => assertCanWriteProjectsOrKpis(principalFor(role, { employeeId: null })));
    assert.equal(error?.code, "role_not_allowed", role);
    assert.match(error.message, /not linked to an employee record/);
  }
});

test("a manager or tl with no department has no scope and is denied; admin and hr need none", () => {
  for (const role of ["manager", "tl"]) {
    const error = errorOf(() => assertCanWriteProjectsOrKpis(principalFor(role, { departmentId: null })));
    assert.equal(error?.code, "role_not_allowed", role);
    assert.match(error.message, /no department/);
  }
  for (const role of ["admin", "hr"]) {
    assert.equal(errorOf(() => assertCanWriteProjectsOrKpis(principalFor(role, { departmentId: null }))), null, role);
  }
});

// ---------------------------------------------------------------------------
// The existing project (first half of the two-sided check)
// ---------------------------------------------------------------------------

test("canManageExistingProject: admin and hr manage any project in any department", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(canManageExistingProject(principalFor(role), project()), true, role);
    assert.equal(canManageExistingProject(principalFor(role), project({ department_id: OTHER_DEPARTMENT })), true, role);
  }
});

test("canManageExistingProject: a manager manages their own department's projects and no one else's", () => {
  const manager = principalFor("manager");
  assert.equal(canManageExistingProject(manager, project({ department_id: DEPARTMENT })), true);
  assert.equal(canManageExistingProject(manager, project({ department_id: OTHER_DEPARTMENT })), false);
});

test("canManageExistingProject: a tl manages a project in their department that they lead", () => {
  assert.equal(canManageExistingProject(principalFor("tl"), project({ team_lead_id: TL })), true);
});

test("canManageExistingProject: a tl also manages a project led by someone else if any assignee reports to them", () => {
  const partlyTheirs = project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL, TL] });
  assert.equal(canManageExistingProject(principalFor("tl"), partlyTheirs), true);
});

test("canManageExistingProject: a tl does not manage a project that is neither theirs nor has their people", () => {
  const unrelated = project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL] });
  assert.equal(canManageExistingProject(principalFor("tl"), unrelated), false);
  assert.equal(canManageExistingProject(principalFor("tl"), project({ team_lead_id: null })), false);
});

test("canManageExistingProject: a tl never manages a project in another department, even one they lead", () => {
  assert.equal(
    canManageExistingProject(principalFor("tl"), project({ department_id: OTHER_DEPARTMENT, team_lead_id: TL, assigneeTeamLeadIds: [TL] })),
    false,
  );
});

test("canManageExistingProject: employee, and a role it does not know, manage nothing", () => {
  assert.equal(canManageExistingProject(principalFor("employee"), project({ team_lead_id: "principal-emp" })), false);
  assert.equal(canManageExistingProject({ role: "nonsense", employeeId: "x", departmentId: DEPARTMENT }, project()), false);
});

test("assertCanManageExistingProject: denies with 403 project_scope_denied", () => {
  const error = errorOf(() => assertCanManageExistingProject(principalFor("manager"), project({ department_id: OTHER_DEPARTMENT })));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "project_scope_denied");
  assert.equal(errorOf(() => assertCanManageExistingProject(principalFor("manager"), project())), null);
});

// ---------------------------------------------------------------------------
// The resulting project (second half of the two-sided check)
// ---------------------------------------------------------------------------

test("assertResultingProjectInScope: admin and hr are unconditional, whatever the project would become", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(errorOf(() => assertResultingProjectInScope(
      principalFor(role),
      project({ department_id: OTHER_DEPARTMENT, team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL] }),
    )), null, role);
  }
});

test("assertResultingProjectInScope: a manager's project must end up in their own department", () => {
  const manager = principalFor("manager");
  assert.equal(errorOf(() => assertResultingProjectInScope(manager, project({ department_id: DEPARTMENT }))), null);

  const error = errorOf(() => assertResultingProjectInScope(manager, project({ department_id: OTHER_DEPARTMENT })));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "project_scope_denied");
  assert.match(error.message, /outside your department/);
});

test("assertResultingProjectInScope: a manager may lead nothing in particular -- the lead and assignees are not their concern", () => {
  assert.equal(errorOf(() => assertResultingProjectInScope(
    principalFor("manager"),
    project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL, null] }),
  )), null);
});

test("assertResultingProjectInScope: a tl's project must be led by them, in their department, with only their team assigned", () => {
  const whollyTheirs = project({ team_lead_id: TL, assigneeTeamLeadIds: [TL, TL] });
  assert.equal(errorOf(() => assertResultingProjectInScope(principalFor("tl"), whollyTheirs)), null);
});

test("assertResultingProjectInScope: a tl is refused when they are not the lead (leg 1)", () => {
  for (const lead of [OTHER_TL, null]) {
    const error = errorOf(() => assertResultingProjectInScope(
      principalFor("tl"),
      project({ team_lead_id: lead, assigneeTeamLeadIds: [TL] }),
    ));
    assert.equal(error?.code, "project_scope_denied", String(lead));
  }
});

test("assertResultingProjectInScope: a tl is refused when any assignee is off their team (leg 2)", () => {
  for (const assignees of [[TL, OTHER_TL], [null], [TL, null]]) {
    const error = errorOf(() => assertResultingProjectInScope(
      principalFor("tl"),
      project({ team_lead_id: TL, assigneeTeamLeadIds: assignees }),
    ));
    assert.equal(error?.statusCode, 403, JSON.stringify(assignees));
    assert.equal(error.code, "project_scope_denied", JSON.stringify(assignees));
  }
});

test("assertResultingProjectInScope: a tl is refused when the project would be in another department (leg 3)", () => {
  const error = errorOf(() => assertResultingProjectInScope(
    principalFor("tl"),
    project({ department_id: OTHER_DEPARTMENT, team_lead_id: TL, assigneeTeamLeadIds: [TL] }),
  ));
  assert.equal(error?.code, "project_scope_denied");
});

test("the two halves are independent: a tl can pass the existing check yet fail the resulting one", () => {
  // The project is led by someone else but has a TL's person on it: manageable as it stands, but
  // not a state this tl may hold -- which is why such a tl can delete it but never edit it.
  const stored = project({ team_lead_id: OTHER_TL, assigneeTeamLeadIds: [OTHER_TL, TL] });
  const tl = principalFor("tl");
  assert.equal(canManageExistingProject(tl, stored), true);
  assert.equal(errorOf(() => assertResultingProjectInScope(tl, stored))?.code, "project_scope_denied");
});

test("the two halves are independent the other way: a manager passes both only when the department is theirs throughout", () => {
  const manager = principalFor("manager");
  const stored = project({ department_id: DEPARTMENT });
  assert.equal(canManageExistingProject(manager, stored), true);
  // An existing project they manage, edited into another department, is refused on the resulting side.
  assert.equal(
    errorOf(() => assertResultingProjectInScope(manager, { ...stored, department_id: OTHER_DEPARTMENT }))?.code,
    "project_scope_denied",
  );
});
