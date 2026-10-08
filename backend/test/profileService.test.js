import assert from "node:assert/strict";
import test from "node:test";
import { createProfileService } from "../src/services/profileService.js";

// No database. A fake employeeRepository stands in for the real one, whose SQL (department_name, the
// float8 money columns, joined_on as text) is employeeRepository.test.js's concern and the end-to-end
// script's. What is proved here is what the service does with the row it gets (D32).

// An employee row exactly as employeeRepository.findById returns it.
const ROW = Object.freeze({
  id: "emp-1", user_id: "user-1", company_id: "co-1", department_id: "dept-1", department_name: "Engineering",
  team_lead_id: "tl-1", employee_number: "EMP-0007", full_name: "Aisha Khan", phone: "0300-1234567",
  position_title: "Engineer", employment_status: "active", joined_on: "2024-03-15",
  basic: 120000, allowances: 15000, created_at: new Date(), updated_at: new Date(),
  role: "employee", email: "aisha@example.com",
});

function fakeRepository(row = ROW) {
  const calls = [];
  return { calls, async findById(id) { calls.push(id); return row; } };
}

const principal = (overrides = {}) => ({ userId: "user-1", employeeId: "emp-1", role: "employee", departmentId: "dept-1", ...overrides });

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

test("returns the caller's own profile: the fields the session needs, in the API's names", async () => {
  const profile = await createProfileService({ employeeRepository: fakeRepository() }).getOwnProfile(principal());

  assert.deepEqual(profile, {
    id: "emp-1", employee_number: "EMP-0007", full_name: "Aisha Khan", email: "aisha@example.com",
    phone: "0300-1234567", role: "employee", department_id: "dept-1", department_name: "Engineering",
    position_title: "Engineer", joined_on: "2024-03-15", team_lead_id: "tl-1", employment_status: "active",
  });
});

test("D33 -- it carries department_name beside department_id, so a manager, tl or employee can show it", async () => {
  const profile = await createProfileService({ employeeRepository: fakeRepository() }).getOwnProfile(principal({ role: "employee" }));

  assert.equal(profile.department_id, "dept-1");
  assert.equal(profile.department_name, "Engineering");
});

test("it leaves out compensation and the internal ids -- the session does not need them", async () => {
  const profile = await createProfileService({ employeeRepository: fakeRepository() }).getOwnProfile(principal());

  for (const field of ["basic", "allowances", "user_id", "company_id", "created_at", "updated_at"]) {
    assert.equal(Object.hasOwn(profile, field), false, field);
  }
});

test("the employee is taken from the authenticated principal, and nothing else is ever looked up", async () => {
  const repository = fakeRepository();
  await createProfileService({ employeeRepository: repository }).getOwnProfile(principal({ employeeId: "emp-9" }));

  assert.deepEqual(repository.calls, ["emp-9"]);
});

test("a null phone and a null team lead are kept as null, not dropped or stringified", async () => {
  const row = { ...ROW, phone: null, team_lead_id: null };
  const profile = await createProfileService({ employeeRepository: fakeRepository(row) }).getOwnProfile(principal());

  assert.strictEqual(profile.phone, null);
  assert.strictEqual(profile.team_lead_id, null);
});

test("joined_on is passed through as the YYYY-MM-DD text the repository selects", async () => {
  const profile = await createProfileService({ employeeRepository: fakeRepository() }).getOwnProfile(principal());

  assert.match(profile.joined_on, /^\d{4}-\d{2}-\d{2}$/);
});

test("the profile reports the stored role for every role", async () => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    const profile = await createProfileService({ employeeRepository: fakeRepository({ ...ROW, role }) }).getOwnProfile(principal({ role }));
    assert.equal(profile.role, role);
  }
});

test("a principal whose employee row has gone is 404, not a crash", async () => {
  const error = await rejection(createProfileService({ employeeRepository: fakeRepository(null) }).getOwnProfile(principal()));

  assert.equal(error?.statusCode, 404);
  assert.equal(error.code, "not_found");
});

test("a principal with no employee id, or no principal at all, is 404 and the repository is never asked", async () => {
  for (const bad of [principal({ employeeId: null }), principal({ employeeId: undefined }), null, undefined]) {
    const repository = fakeRepository();
    const error = await rejection(createProfileService({ employeeRepository: repository }).getOwnProfile(bad));

    assert.equal(error?.statusCode, 404);
    assert.equal(repository.calls.length, 0);
  }
});
