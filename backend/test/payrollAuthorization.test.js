import assert from "node:assert/strict";
import test from "node:test";
import { assertCanWritePayroll } from "../src/services/payrollAuthorizationService.js";
import { PAYROLL_ROLES } from "../src/services/employeeAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level, mirroring attendanceAuthorization.test.js. The rule is D28:
// admin and hr, for any employee -- there is no per-employee scope, so one gate is the whole
// authorization decision. payrollMutationService.test.js and payrollRoutes.test.js prove it is
// actually wired in.

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: "principal-emp",
  role,
  departmentId: "dept-1",
  isTeamLead: role === "tl",
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

test("assertCanWritePayroll: admin and hr are allowed; manager, tl and employee are denied", () => {
  for (const role of USER_ROLES) {
    const error = errorOf(() => assertCanWritePayroll(principalFor(role)));
    if (role === "admin" || role === "hr") {
      assert.equal(error, null, `${role} should be allowed`);
    } else {
      assert.equal(error?.statusCode, 403, `${role} should be denied`);
      assert.equal(error.code, "role_not_allowed", role);
    }
  }
});

test("assertCanWritePayroll: department and team scope make no difference -- a manager is still denied", () => {
  // Payroll has no scope concept (D28): a manager in the very department of the employee is
  // denied exactly like any other manager, and a tl over their own team likewise.
  assert.equal(errorOf(() => assertCanWritePayroll(principalFor("manager", { departmentId: "dept-1" })))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWritePayroll(principalFor("tl")))?.code, "role_not_allowed");
});

test("assertCanWritePayroll: admin and hr are company-wide -- no department is required", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(errorOf(() => assertCanWritePayroll(principalFor(role, { departmentId: null }))), null, role);
  }
});

test("assertCanWritePayroll reuses PAYROLL_ROLES, the set that already gates changing basic and allowances", () => {
  assert.deepEqual([...PAYROLL_ROLES].sort(), ["admin", "hr"]);
});

test("assertCanWritePayroll: a principal with no role, or no principal at all, is denied rather than crashed", () => {
  assert.equal(errorOf(() => assertCanWritePayroll({}))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWritePayroll(null))?.code, "role_not_allowed");
  assert.equal(errorOf(() => assertCanWritePayroll(undefined))?.code, "role_not_allowed");
});

test("assertCanWritePayroll: an account not linked to an employee record is denied, even an admin", () => {
  // The acting employee's id becomes deleted_by_employee_id (D28), so there must be one.
  for (const role of ["admin", "hr"]) {
    const error = errorOf(() => assertCanWritePayroll(principalFor(role, { employeeId: null })));
    assert.equal(error?.statusCode, 403, role);
    assert.equal(error.code, "role_not_allowed", role);
    assert.match(error.message, /not linked to an employee record/);
  }
});
