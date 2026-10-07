import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanApply,
  assertCanDecide,
  assertCanDecideRole,
  resolveDeleteMode,
} from "../src/services/leaveAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level, mirroring payrollAuthorization.test.js. The rules are D31:
// every role may apply for themselves, the Firestore approval scopes carry over, nobody decides
// their own request (a DATABASE rule, deliberately not asserted by these functions), and delete is
// an employee's own pending cancel or an admin/hr correction. leaveMutationService.test.js and
// leaveRoutes.test.js prove they are wired in.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const TL = "tl-1";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id", employeeId: "principal-emp", role, departmentId: DEPARTMENT, ...overrides,
});

/** A leave as leaveRepository.findByIdForWrite returns it. */
const leave = (overrides = {}) => ({
  id: "leave-1", employee_id: "emp-1", status: "pending",
  employee_department_id: DEPARTMENT, employee_team_lead_id: TL, ...overrides,
});

const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};
const outcome = (fn) => {
  const error = errorOf(fn);
  return error ? `${error.statusCode} ${error.code}` : "ok";
};

// ---------------------------------------------------------------------------
// Apply (D12): every role, for themselves
// ---------------------------------------------------------------------------

test("assertCanApply: every role may apply -- not just the employee role", () => {
  for (const role of USER_ROLES) {
    assert.equal(outcome(() => assertCanApply(principalFor(role))), "ok", role);
  }
});

test("assertCanApply: an account with no employee record cannot apply, even an admin", () => {
  for (const role of USER_ROLES) {
    const error = errorOf(() => assertCanApply(principalFor(role, { employeeId: null })));
    assert.equal(error?.statusCode, 403, role);
    assert.equal(error.code, "role_not_allowed", role);
    assert.match(error.message, /not linked to an employee record/);
  }
});

test("assertCanApply: no principal, or an unknown role, is denied rather than crashed", () => {
  assert.equal(outcome(() => assertCanApply(null)), "403 role_not_allowed");
  assert.equal(outcome(() => assertCanApply(undefined)), "403 role_not_allowed");
  assert.equal(outcome(() => assertCanApply({})), "403 role_not_allowed");
  assert.equal(outcome(() => assertCanApply(principalFor("superuser"))), "403 role_not_allowed");
});

test("assertCanApply needs no department -- admin and hr have none, and a department is not part of applying", () => {
  assert.equal(outcome(() => assertCanApply(principalFor("admin", { departmentId: null }))), "ok");
});

// ---------------------------------------------------------------------------
// Decide: the Firestore scopes, carried over
// ---------------------------------------------------------------------------

test("assertCanDecideRole: admin, hr, manager and tl pass; employee is denied", () => {
  for (const role of USER_ROLES) {
    const expected = ["admin", "hr", "manager", "tl"].includes(role) ? "ok" : "403 role_not_allowed";
    assert.equal(outcome(() => assertCanDecideRole(principalFor(role))), expected, role);
  }
});

test("assertCanDecideRole: an account with no employee record is denied, and so is no principal", () => {
  assert.equal(outcome(() => assertCanDecideRole(principalFor("admin", { employeeId: null }))), "403 role_not_allowed");
  assert.equal(outcome(() => assertCanDecideRole(null)), "403 role_not_allowed");
});

test("assertCanDecide: admin and hr may decide any request, in any department", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(outcome(() => assertCanDecide(principalFor(role), leave())), "ok", role);
    assert.equal(
      outcome(() => assertCanDecide(principalFor(role), leave({ employee_department_id: OTHER_DEPARTMENT }))), "ok", role,
    );
  }
});

test("assertCanDecide: a manager decides their own department's requests and no one else's", () => {
  const manager = principalFor("manager");
  assert.equal(outcome(() => assertCanDecide(manager, leave())), "ok");
  assert.equal(
    outcome(() => assertCanDecide(manager, leave({ employee_department_id: OTHER_DEPARTMENT }))),
    "403 leave_scope_denied",
  );
});

test("assertCanDecide: a manager with no department covers nobody", () => {
  assert.equal(
    outcome(() => assertCanDecide(principalFor("manager", { departmentId: null }), leave({ employee_department_id: undefined }))),
    "403 leave_scope_denied",
  );
  assert.equal(
    outcome(() => assertCanDecide(principalFor("manager", { departmentId: null }), leave())),
    "403 leave_scope_denied",
  );
});

test("assertCanDecide: a tl decides requests from employees who report to them, and no one else's", () => {
  const tl = principalFor("tl", { employeeId: TL });
  assert.equal(outcome(() => assertCanDecide(tl, leave())), "ok");
  assert.equal(
    outcome(() => assertCanDecide(principalFor("tl", { employeeId: "tl-2" }), leave())),
    "403 leave_scope_denied",
  );
  assert.equal(outcome(() => assertCanDecide(tl, leave({ employee_team_lead_id: null }))), "403 leave_scope_denied");
});

test("assertCanDecide: a tl's scope is their TEAM, not their department -- a colleague in the same department is out", () => {
  const tl = principalFor("tl", { employeeId: TL, departmentId: DEPARTMENT });
  assert.equal(
    outcome(() => assertCanDecide(tl, leave({ employee_department_id: DEPARTMENT, employee_team_lead_id: "tl-2" }))),
    "403 leave_scope_denied",
  );
});

test("assertCanDecide: an employee-role account is denied before scope is even considered", () => {
  assert.equal(outcome(() => assertCanDecide(principalFor("employee"), leave())), "403 role_not_allowed");
});

test("assertCanDecide: D8 -- a self-decision is NOT checked here; leaves_no_self_approval is what refuses it", () => {
  // An admin and a manager deciding their OWN request pass this function on purpose: the database
  // constraint must remain the thing that provably says no, so it is never duplicated here.
  const ownRequest = leave({ employee_id: "principal-emp" });
  assert.equal(outcome(() => assertCanDecide(principalFor("admin", { employeeId: "principal-emp" }), ownRequest)), "ok");
  assert.equal(outcome(() => assertCanDecide(principalFor("hr", { employeeId: "principal-emp" }), ownRequest)), "ok");
  assert.equal(outcome(() => assertCanDecide(principalFor("manager", { employeeId: "principal-emp" }), ownRequest)), "ok");
});

test("assertCanDecide: a tl can never reach a self-decision -- their own request is not in their own team", () => {
  // An employee cannot be their own team lead (employees_not_own_team_lead), so a tl's request carries
  // some other lead or none, and the scope check refuses it before the database is ever asked.
  const tl = principalFor("tl", { employeeId: TL });
  assert.equal(
    outcome(() => assertCanDecide(tl, leave({ employee_id: TL, employee_team_lead_id: null }))),
    "403 leave_scope_denied",
  );
});

// ---------------------------------------------------------------------------
// Delete: own pending cancel, or an admin/hr correction
// ---------------------------------------------------------------------------

test("resolveDeleteMode: admin and hr may delete a leave in ANY status", () => {
  for (const role of ["admin", "hr"]) {
    for (const status of ["pending", "approved", "rejected"]) {
      const error = errorOf(() => resolveDeleteMode(principalFor(role), leave({ status })));
      assert.equal(error, null, `${role} ${status}`);
      assert.deepEqual(resolveDeleteMode(principalFor(role), leave({ status })), { pendingOnly: false }, `${role} ${status}`);
    }
  }
});

test("resolveDeleteMode: an employee, in ANY role, may cancel their OWN pending request -- pendingOnly", () => {
  for (const role of ["employee", "tl", "manager"]) {
    const principal = principalFor(role, { employeeId: "emp-1" });
    assert.deepEqual(resolveDeleteMode(principal, leave({ employee_id: "emp-1", status: "pending" })), { pendingOnly: true }, role);
  }
});

test("resolveDeleteMode: an employee cannot cancel their own request once it is decided -- 409 leave_already_decided", () => {
  for (const status of ["approved", "rejected"]) {
    const error = errorOf(() => resolveDeleteMode(
      principalFor("employee", { employeeId: "emp-1" }), leave({ employee_id: "emp-1", status }),
    ));
    assert.equal(error?.statusCode, 409, status);
    assert.equal(error.code, "leave_already_decided", status);
  }
});

test("resolveDeleteMode: nobody else may delete someone's request -- not an employee, a tl or even a manager", () => {
  for (const role of ["employee", "tl", "manager"]) {
    for (const status of ["pending", "approved"]) {
      const error = errorOf(() => resolveDeleteMode(principalFor(role, { employeeId: "someone-else" }), leave({ employee_id: "emp-1", status })));
      assert.equal(error?.statusCode, 403, `${role} ${status}`);
      assert.equal(error.code, "leave_scope_denied", `${role} ${status}`);
    }
  }
});

test("resolveDeleteMode: a manager or tl may not use their approval scope to delete -- scope to decide is not scope to delete", () => {
  assert.equal(
    outcome(() => resolveDeleteMode(principalFor("manager"), leave())),
    "403 leave_scope_denied",
  );
  assert.equal(
    outcome(() => resolveDeleteMode(principalFor("tl", { employeeId: TL }), leave())),
    "403 leave_scope_denied",
  );
});

test("resolveDeleteMode: an account with no employee record, or no principal, is denied", () => {
  assert.equal(outcome(() => resolveDeleteMode(principalFor("admin", { employeeId: null }), leave())), "403 role_not_allowed");
  assert.equal(outcome(() => resolveDeleteMode(null, leave())), "403 role_not_allowed");
});
