import assert from "node:assert/strict";
import test from "node:test";
import { assertCanResetPassword } from "../src/services/employeeAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// D41: who may set a temporary password for an EXISTING employee. The reason hr cannot reset an admin is the point of
// the file: setting someone's password and then signing in as them is account takeover.

const DEPARTMENT = "dept-1";
const principalFor = (role, overrides = {}) => ({ userId: "u-actor", employeeId: "actor", role, departmentId: DEPARTMENT, ...overrides });
const target = (role, overrides = {}) => ({ id: "target", role, department_id: DEPARTMENT, team_lead_id: null, ...overrides });

const outcome = (principal, row) => {
  try {
    assertCanResetPassword(principal, row);
    return "allowed";
  } catch (error) {
    return `${error.statusCode} ${error.code}`;
  }
};

// The full matrix: actor role x target role, both in the same department so scope is not what decides it.
const EXPECTED = {
  admin:    { admin: "allowed", hr: "allowed", manager: "allowed", tl: "allowed", employee: "allowed" },
  hr:       { admin: "403 employee_scope_denied", hr: "403 employee_scope_denied", manager: "allowed", tl: "allowed", employee: "allowed" },
  manager:  Object.fromEntries(USER_ROLES.map((role) => [role, "403 role_not_allowed"])),
  tl:       Object.fromEntries(USER_ROLES.map((role) => [role, "403 role_not_allowed"])),
  employee: Object.fromEntries(USER_ROLES.map((role) => [role, "403 role_not_allowed"])),
};

for (const actor of USER_ROLES) {
  for (const subject of USER_ROLES) {
    test(`reset matrix: ${actor} -> ${subject} is ${EXPECTED[actor][subject]}`, () => {
      assert.equal(outcome(principalFor(actor), target(subject)), EXPECTED[actor][subject]);
    });
  }
}

test("only admin and hr can ever reset anything: manager and tl are refused even for the people they manage", () => {
  assert.equal(outcome(principalFor("manager"), target("employee")), "403 role_not_allowed");
  assert.equal(outcome(principalFor("tl"), target("employee", { team_lead_id: "actor" })), "403 role_not_allowed");
});

test("nobody resets their OWN password, whatever their role: changing it asks for the current one", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(outcome(principalFor(role), target(role, { id: "actor" })), "403 self_reset_denied", role);
  }
});

test("self-reset is refused BEFORE the hierarchy, so the message says what is actually wrong", () => {
  // hr -> hr would otherwise read as a hierarchy refusal.
  assert.equal(outcome(principalFor("hr"), target("hr", { id: "actor" })), "403 self_reset_denied");
});

test("hr cannot reset an admin even when the admin is in hr's own department: this is the takeover the rule exists to prevent", () => {
  assert.equal(outcome(principalFor("hr"), target("admin", { department_id: DEPARTMENT })), "403 employee_scope_denied");
});

test("admin and hr are company-wide: a target in another department is still resettable (within the hierarchy)", () => {
  for (const role of ["admin", "hr"]) {
    assert.equal(outcome(principalFor(role), target("employee", { department_id: "some-other-department" })), "allowed", role);
  }
});

test("a missing target is a 404 for everyone, before any role decision, so the answer cannot reveal who may do what", () => {
  for (const role of USER_ROLES) {
    assert.equal(outcome(principalFor(role), null), "404 not_found", role);
    assert.equal(outcome(principalFor(role), {}), "404 not_found", role);
  }
});

test("an account whose role is unknown, or with no employee record, can reset nothing", () => {
  assert.match(outcome({ userId: "u", role: "superuser" }, target("employee")), /^403 role_not_allowed/);
  assert.match(outcome(principalFor("admin", { employeeId: null }), target("employee")), /^403 role_not_allowed/);
  assert.match(outcome(null, target("employee")), /^403 role_not_allowed/);
});
