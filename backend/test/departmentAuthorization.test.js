import assert from "node:assert/strict";
import test from "node:test";
import { assertCanWriteDepartment } from "../src/services/departmentAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Pure-function level, mirroring employeeAuthorization.test.js's style. One
// function covers all three operations (create/update/delete share the same gate), so one
// matrix here is the whole authorization layer; the HTTP layer (departmentRoutes.test.js)
// proves each operation is actually wired to it.

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: "emp-id",
  role,
  departmentId: "dept-1",
  isTeamLead: role === "tl",
  ...overrides,
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};

test("assertCanWriteDepartment: admin only -- every other role is denied", () => {
  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    const code = codeOf(() => assertCanWriteDepartment(principal));
    if (role === "admin") {
      assert.equal(code, null, `${role} should be allowed`);
    } else {
      assert.equal(code, "role_not_allowed", `${role} should be denied`);
    }
  }
});

test("assertCanWriteDepartment: hr is denied, deliberately not COMPANY_WIDE_ROLES", () => {
  // The read side (departmentRepository.js) gates on COMPANY_WIDE_ROLES (admin + hr), but
  // writes are admin-only -- hr can read departments and never write them, matching
  // firestore.rules and migration-plan.md's Phase 5 note.
  assert.throws(() => assertCanWriteDepartment(principalFor("hr")), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "role_not_allowed");
    return true;
  });
});

test("assertCanWriteDepartment: an unauthenticated-shaped principal (no role) is denied, not crashed", () => {
  assert.equal(codeOf(() => assertCanWriteDepartment({})), "role_not_allowed");
  assert.equal(codeOf(() => assertCanWriteDepartment(null)), "role_not_allowed");
});
