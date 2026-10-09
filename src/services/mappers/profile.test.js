import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { SESSION_USER_FIELDS, fromApi } from "./profile.js";

// GET /auth/me exactly as backend/src/services/profileService.js returns it.
const PROFILE = Object.freeze({
  id: "e1", employee_number: "EMP-0007", full_name: "Aisha Khan", email: "aisha@example.com", phone: "0300-1234567",
  role: "employee", department_id: "d1", department_name: "Engineering", position_title: "Engineer",
  joined_on: "2024-03-15", team_lead_id: "tl1", employment_status: "active",
});

test("fromApi produces the session user the app already uses", () => {
  assert.deepEqual(fromApi(PROFILE), {
    id: "e1", name: "Aisha Khan", email: "aisha@example.com", phone: "0300-1234567", dept: "Engineering",
    pos: "Engineer", joinDate: "2024-03-15", empId: "EMP-0007", role: "employee",
  });
});

test("the session user has exactly the nine fields, all strings", () => {
  const user = fromApi(PROFILE);

  assert.deepEqual(Object.keys(user).sort(), [...SESSION_USER_FIELDS].sort());
  assert.equal(SESSION_USER_FIELDS.length, 9);
  for (const field of SESSION_USER_FIELDS) assert.equal(typeof user[field], "string", field);
});

test("dept is the department NAME (D33), and '' when the account has none, since the app requires a string", () => {
  assert.equal(fromApi({ ...PROFILE, department_name: null, department_id: null }).dept, "");
  assert.equal(fromApi(PROFILE).dept, "Engineering");
});

test("a null phone becomes an empty string", () => {
  assert.equal(fromApi({ ...PROFILE, phone: null }).phone, "");
});

test("all five roles are accepted", () => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    assert.equal(fromApi({ ...PROFILE, role }).role, role);
  }
});

test("a profile the app cannot trust is refused", () => {
  const bad = [
    null, undefined, "x", {},
    { ...PROFILE, id: "" },
    { ...PROFILE, id: 7 },
    { ...PROFILE, full_name: "  " },
    { ...PROFILE, email: "not-an-email" },
    { ...PROFILE, role: "superuser" },
    { ...PROFILE, role: undefined },
  ];
  for (const profile of bad) {
    assert.throws(() => fromApi(profile), (error) => error instanceof MappingError && error.code === "malformed-profile");
  }
});

test("compensation never reaches the session user, even if a response carried it", () => {
  const user = fromApi({ ...PROFILE, basic: 1, allowances: 2 });

  assert.equal(Object.hasOwn(user, "basic"), false);
  assert.equal(Object.hasOwn(user, "allowances"), false);
});
