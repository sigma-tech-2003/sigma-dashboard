import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanReattributeAttendance,
  assertCanWriteAttendance,
  assertCanWriteAttendanceFor,
} from "../src/services/attendanceAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level, mirroring departmentAuthorization.test.js. The
// authorization rules themselves are D27: admin and hr for anyone, manager for their own
// department, nobody else. attendanceMutationService.test.js and attendanceRoutes.test.js
// prove these functions are actually wired in.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: "principal-emp",
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
  ...overrides,
});

const employeeIn = (departmentId, id = "target-emp") => ({ id, department_id: departmentId });

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

test("assertCanWriteAttendance: admin, hr and manager are allowed; tl and employee are denied", () => {
  for (const role of USER_ROLES) {
    const error = errorOf(() => assertCanWriteAttendance(principalFor(role)));
    if (["admin", "hr", "manager"].includes(role)) {
      assert.equal(error, null, `${role} should be allowed`);
    } else {
      assert.equal(error?.statusCode, 403, `${role} should be denied`);
      assert.equal(error.code, "role_not_allowed", role);
    }
  }
});

test("assertCanWriteAttendance: hr is allowed -- the frontend's isAdminRole groups it with admin", () => {
  assert.equal(errorOf(() => assertCanWriteAttendance(principalFor("hr"))), null);
});

test("assertCanWriteAttendance: a principal with no role, no principal, or no employee record is denied, not crashed", () => {
  assert.equal(errorOf(() => assertCanWriteAttendance({}))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWriteAttendance(null))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWriteAttendance(undefined))?.code, "role_not_allowed");
  // The acting employee's id becomes deleted_by_employee_id (D27), so an account that is not
  // linked to an employee record cannot write -- not even an admin.
  for (const role of ["admin", "hr", "manager"]) {
    const error = errorOf(() => assertCanWriteAttendance(principalFor(role, { employeeId: null })));
    assert.equal(error?.code, "role_not_allowed", role);
  }
});

// ---------------------------------------------------------------------------
// Scope over one employee
// ---------------------------------------------------------------------------

test("assertCanWriteAttendanceFor: admin and hr cover every department", () => {
  for (const role of ["admin", "hr"]) {
    for (const departmentId of [DEPARTMENT, OTHER_DEPARTMENT]) {
      assert.equal(
        errorOf(() => assertCanWriteAttendanceFor(principalFor(role), employeeIn(departmentId))),
        null,
        `${role} in ${departmentId}`,
      );
    }
  }
});

test("assertCanWriteAttendanceFor: a manager covers their own department only", () => {
  const manager = principalFor("manager");
  assert.equal(errorOf(() => assertCanWriteAttendanceFor(manager, employeeIn(DEPARTMENT))), null);

  const error = errorOf(() => assertCanWriteAttendanceFor(manager, employeeIn(OTHER_DEPARTMENT)));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
});

test("assertCanWriteAttendanceFor: a manager may write their own record (same department)", () => {
  const manager = principalFor("manager", { employeeId: "manager-emp" });
  assert.equal(
    errorOf(() => assertCanWriteAttendanceFor(manager, employeeIn(DEPARTMENT, "manager-emp"))),
    null,
  );
});

test("assertCanWriteAttendanceFor: a manager with no department covers nobody", () => {
  const manager = principalFor("manager", { departmentId: null });
  const error = errorOf(() => assertCanWriteAttendanceFor(manager, employeeIn(DEPARTMENT)));
  assert.equal(error?.code, "attendance_scope_denied");
});

test("assertCanWriteAttendanceFor: tl and employee are denied by the role gate even over their own scope", () => {
  // scopeCoversEmployee would let a tl cover their team and an employee cover themselves --
  // that is the READ scope. Writes are role-gated first, so neither ever reaches it.
  const tl = principalFor("tl", { employeeId: "tl-emp" });
  assert.equal(
    errorOf(() => assertCanWriteAttendanceFor(tl, { id: "member", team_lead_id: "tl-emp", department_id: DEPARTMENT }))?.code,
    "role_not_allowed",
  );

  const employee = principalFor("employee", { employeeId: "emp-1" });
  assert.equal(
    errorOf(() => assertCanWriteAttendanceFor(employee, employeeIn(DEPARTMENT, "emp-1")))?.code,
    "role_not_allowed",
  );
});

// ---------------------------------------------------------------------------
// Re-attribution: the scope check covers FROM and TO (D27)
// ---------------------------------------------------------------------------

test("assertCanReattributeAttendance: a manager cannot pull a record IN from another department", () => {
  // FROM is outside the manager's department, TO is inside it. Checking only the destination
  // would let the manager end up holding a record they were never allowed to touch.
  const error = errorOf(() => assertCanReattributeAttendance(principalFor("manager"), {
    from: employeeIn(OTHER_DEPARTMENT, "from-emp"),
    to: employeeIn(DEPARTMENT, "to-emp"),
  }));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
  assert.match(error.message, /belongs to an employee outside your scope/);
});

test("assertCanReattributeAttendance: a manager cannot push a record OUT to another department", () => {
  const error = errorOf(() => assertCanReattributeAttendance(principalFor("manager"), {
    from: employeeIn(DEPARTMENT, "from-emp"),
    to: employeeIn(OTHER_DEPARTMENT, "to-emp"),
  }));
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
  assert.match(error.message, /moving this record to is outside your scope/);
});

test("assertCanReattributeAttendance: FROM is evaluated first -- both out of scope reports the FROM side", () => {
  const error = errorOf(() => assertCanReattributeAttendance(principalFor("manager"), {
    from: employeeIn(OTHER_DEPARTMENT, "from-emp"),
    to: employeeIn("dept-3", "to-emp"),
  }));
  assert.match(error?.message ?? "", /belongs to an employee outside your scope/);
});

test("assertCanReattributeAttendance: both employees inside the manager's department is allowed", () => {
  assert.equal(errorOf(() => assertCanReattributeAttendance(principalFor("manager"), {
    from: employeeIn(DEPARTMENT, "from-emp"),
    to: employeeIn(DEPARTMENT, "to-emp"),
  })), null);
});

test("assertCanReattributeAttendance: admin and hr may move a record across departments", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(errorOf(() => assertCanReattributeAttendance(principalFor(role), {
      from: employeeIn(OTHER_DEPARTMENT, "from-emp"),
      to: employeeIn(DEPARTMENT, "to-emp"),
    })), null, role);
  }
});

test("assertCanReattributeAttendance: tl and employee are denied by the role gate", () => {
  for (const role of ["tl", "employee"]) {
    const error = errorOf(() => assertCanReattributeAttendance(principalFor(role), {
      from: employeeIn(DEPARTMENT, "from-emp"),
      to: employeeIn(DEPARTMENT, "to-emp"),
    }));
    assert.equal(error?.code, "role_not_allowed", role);
  }
});
