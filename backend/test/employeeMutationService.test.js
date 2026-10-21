import assert from "node:assert/strict";
import test from "node:test";
import { createEmployeeMutationService } from "../src/services/employeeMutationService.js";

// No database. Exercises orchestration (defaulting, the D18 team-lead invariant checks,
// wiring into employeeAuthorizationService) against a fake repository -- the authorization
// MATRIX itself is covered exhaustively in employeeAuthorization.test.js; these tests only
// need enough of it to prove the service calls it correctly and reacts to its decisions.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id", employeeId: "self-id", role, departmentId: DEPARTMENT,
  isTeamLead: role === "tl", ...overrides,
});

const employee = (overrides = {}) => ({
  id: "target-id", user_id: "target-user-id", role: "employee", department_id: DEPARTMENT,
  team_lead_id: null, basic: 50000, allowances: 0, ...overrides,
});

// Argon2 is slow and is not what these tests are about: a recognisable stand-in, so a test can tell the plain password
// from what the service handed on.
// Opaque on purpose: a stand-in that CONTAINED the plain password would make "the plain password never leaves the
// service" impossible to test.
const hashOf = (plain) => `hashed:${Buffer.from(plain).toString("base64")}`;
const fastHash = async (plain) => hashOf(plain);

function fakeUserRepository({ setTemporaryPasswordResult = true } = {}) {
  const calls = { setTemporaryPassword: [] };
  return {
    calls,
    async setTemporaryPassword(userId, passwordHash, setByEmployeeId) {
      calls.setTemporaryPassword.push({ userId, passwordHash, setByEmployeeId });
      return setTemporaryPasswordResult;
    },
  };
}

function makeService(repository, { userRepository = fakeUserRepository() } = {}) {
  return createEmployeeMutationService({ employeeRepository: repository, userRepository, hash: fastHash });
}

function fakeEmployeeRepository(seedEmployees = []) {
  const byId = new Map(seedEmployees.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [], findTeamMembers: [] };
  return {
    calls,
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async findTeamMembers(teamLeadId) {
      calls.findTeamMembers.push(teamLeadId);
      return seedEmployees.filter((row) => row.team_lead_id === teamLeadId && row.id !== teamLeadId);
    },
    async create(input) {
      calls.create.push(input);
      return { id: "new-id", ...input };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id, options) {
      calls.deleteById.push({ id, options });
    },
  };
}

const CREATE_INPUT = Object.freeze({
  email: "new@example.com", role: "employee", full_name: "New Hire", phone: null,
  position_title: "Engineer", joined_on: "2026-09-25", basic: 50000, allowances: 0,
  temporary_password: "temp-pass-1234",
});

// ---------------------------------------------------------------------------
// createEmployee: employment_status (D35)
// ---------------------------------------------------------------------------

test("createEmployee: D35 -- employment_status defaults to 'active' when the caller says nothing", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("admin"), { ...CREATE_INPUT, department_id: DEPARTMENT });

  assert.equal(repository.calls.create[0].employmentStatus, "active");
});

test("createEmployee: D35 -- an explicit 'inactive' is passed to the repository unchanged", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("admin"), { ...CREATE_INPUT, department_id: DEPARTMENT, employment_status: "inactive" });

  assert.equal(repository.calls.create[0].employmentStatus, "inactive");
});

test("createEmployee: D35 -- choosing a status needs no authority beyond that of creating the employee at all", async () => {
  // A manager may create an employee in their own department; they may equally create one inactive.
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("manager"), { ...CREATE_INPUT, employment_status: "inactive" });

  assert.equal(repository.calls.create[0].employmentStatus, "inactive");
});

// ---------------------------------------------------------------------------
// createEmployee: scope defaulting
// ---------------------------------------------------------------------------

test("createEmployee: a manager who omits department_id gets their own department defaulted in", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("manager"), CREATE_INPUT);

  assert.equal(repository.calls.create[0].departmentId, DEPARTMENT);
});

test("createEmployee: a tl who omits department_id and team_lead_id gets both defaulted to themselves", async () => {
  // The service re-validates team_lead_id against the database even when it defaults to
  // the principal's own id -- defense in depth, not a redundant check to optimize away, so
  // the fixture needs the tl's own employee row seeded like any other real one would be.
  const repository = fakeEmployeeRepository([
    employee({ id: "self-id", role: "tl", department_id: DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await service.createEmployee(principalFor("tl"), CREATE_INPUT);

  assert.equal(repository.calls.create[0].departmentId, DEPARTMENT);
  assert.equal(repository.calls.create[0].teamLeadId, "self-id");
});

test("createEmployee: admin/hr must supply department_id explicitly -- there is no scope to default from", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.createEmployee(principalFor("admin"), CREATE_INPUT),
    (error) => { assert.equal(error.statusCode, 400); return true; },
  );
  assert.equal(repository.calls.create.length, 0);
});

test("createEmployee: an explicit department_id outside a manager's own is rejected by authorization, not silently overridden", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.createEmployee(principalFor("manager"), { ...CREATE_INPUT, department_id: OTHER_DEPARTMENT }),
    (error) => { assert.equal(error.code, "employee_scope_denied"); return true; },
  );
  assert.equal(repository.calls.create.length, 0);
});

// ---------------------------------------------------------------------------
// createEmployee: D18 invariants (team lead role/department, employee-only)
// ---------------------------------------------------------------------------

test("createEmployee: team_lead_id must reference someone who actually holds the tl role", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "not-a-tl", role: "employee", department_id: DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await assert.rejects(
    service.createEmployee(principalFor("admin"), {
      ...CREATE_INPUT, department_id: DEPARTMENT, team_lead_id: "not-a-tl",
    }),
    (error) => { assert.equal(error.code, "invalid_team_lead"); return true; },
  );
  assert.equal(repository.calls.create.length, 0);
});

test("createEmployee: team_lead_id must be in the same department as the new employee", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "tl-other-dept", role: "tl", department_id: OTHER_DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await assert.rejects(
    service.createEmployee(principalFor("admin"), {
      ...CREATE_INPUT, department_id: DEPARTMENT, team_lead_id: "tl-other-dept",
    }),
    (error) => { assert.equal(error.code, "invalid_team_lead"); return true; },
  );
});

test("createEmployee: only an employee-role record may have a team lead", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "tl-1", role: "tl", department_id: DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await assert.rejects(
    service.createEmployee(principalFor("admin"), {
      ...CREATE_INPUT, role: "manager", department_id: DEPARTMENT, team_lead_id: "tl-1",
    }),
    (error) => { assert.equal(error.code, "invalid_team_lead"); return true; },
  );
});

test("createEmployee: a valid team lead in the same department is accepted", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "tl-1", role: "tl", department_id: DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await service.createEmployee(principalFor("admin"), {
    ...CREATE_INPUT, department_id: DEPARTMENT, team_lead_id: "tl-1",
  });

  assert.equal(repository.calls.create[0].teamLeadId, "tl-1");
});

// ---------------------------------------------------------------------------
// updateEmployee
// ---------------------------------------------------------------------------

test("updateEmployee: a 404 for a nonexistent target is not swallowed, and updateById is never reached", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.updateEmployee(principalFor("admin"), "missing-id", { phone: "0300" }),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
  assert.equal(repository.calls.updateById.length, 0);
});

test("updateEmployee: changes that don't touch role/department/team_lead_id skip the team-lead validation entirely", async () => {
  const repository = fakeEmployeeRepository([employee()]);
  const service = makeService(repository);

  await service.updateEmployee(principalFor("admin"), "target-id", { phone: "0300" });

  assert.equal(repository.calls.updateById.length, 1);
});

test("updateEmployee: moving department while keeping an old team_lead_id now in a different department is rejected", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "target-id", team_lead_id: "tl-1" }),
    employee({ id: "tl-1", role: "tl", department_id: DEPARTMENT }),
  ]);
  const service = makeService(repository);

  await assert.rejects(
    service.updateEmployee(principalFor("admin"), "target-id", { department_id: OTHER_DEPARTMENT }),
    (error) => { assert.equal(error.code, "invalid_team_lead"); return true; },
  );
  assert.equal(repository.calls.updateById.length, 0);
});

test("updateEmployee: compensation change by a non-payroll role is denied before updateById runs", async () => {
  const repository = fakeEmployeeRepository([employee()]);
  const service = makeService(repository);

  await assert.rejects(
    service.updateEmployee(principalFor("manager"), "target-id", { basic: 999999 }),
    (error) => { assert.equal(error.code, "compensation_change_denied"); return true; },
  );
  assert.equal(repository.calls.updateById.length, 0);
});

// ---------------------------------------------------------------------------
// deleteEmployee
// ---------------------------------------------------------------------------

test("deleteEmployee: a non-tl target never triggers a team-members lookup", async () => {
  const repository = fakeEmployeeRepository([employee()]);
  const service = makeService(repository);

  await service.deleteEmployee(principalFor("manager"), "target-id");

  assert.equal(repository.calls.findTeamMembers.length, 0);
  assert.deepEqual(repository.calls.deleteById[0].options, { replacementTeamLeadId: null, reassignedMemberIds: [] });
});

test("deleteEmployee: a tl with members but no supplied replacement is refused before deleteById runs", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "tl-1", role: "tl" }),
    employee({ id: "member-1", team_lead_id: "tl-1" }),
  ]);
  const service = makeService(repository);

  await assert.rejects(
    service.deleteEmployee(principalFor("manager"), "tl-1"),
    (error) => { assert.equal(error.code, "team_lead_replacement_required"); return true; },
  );
  assert.equal(repository.calls.deleteById.length, 0);
});

test("deleteEmployee: a valid replacement flows through to deleteById with the reassigned member ids", async () => {
  const repository = fakeEmployeeRepository([
    employee({ id: "tl-1", role: "tl" }),
    employee({ id: "member-1", team_lead_id: "tl-1" }),
    employee({ id: "member-2", team_lead_id: "tl-1" }),
  ]);
  const service = makeService(repository);

  await service.deleteEmployee(principalFor("manager"), "tl-1", { replacementTeamLeadId: "member-1" });

  assert.deepEqual(repository.calls.deleteById[0], {
    id: "tl-1",
    options: { replacementTeamLeadId: "member-1", reassignedMemberIds: ["member-2"] },
  });
});

test("deleteEmployee: decision D16 -- a tl with zero members is deleted outright through the full service path", async () => {
  const repository = fakeEmployeeRepository([employee({ id: "tl-1", role: "tl" })]);
  const service = makeService(repository);

  await service.deleteEmployee(principalFor("manager"), "tl-1");

  assert.equal(repository.calls.findTeamMembers.length, 1);
  assert.deepEqual(repository.calls.deleteById[0].options, { replacementTeamLeadId: null, reassignedMemberIds: [] });
});

// ---------------------------------------------------------------------------
// createEmployee: the temporary password (D41)
// ---------------------------------------------------------------------------

test("createEmployee: D41 -- the temporary password is hashed, and only the hash reaches the repository", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("admin"), { ...CREATE_INPUT, department_id: DEPARTMENT });

  const created = repository.calls.create[0];
  assert.equal(created.passwordHash, hashOf("temp-pass-1234"));
  assert.equal(JSON.stringify(created).includes("temp-pass-1234"), false, "the plain password goes no further than the service");
  assert.equal(Object.hasOwn(created, "temporary_password"), false);
});

test("createEmployee: D41 -- the creator's employee id is recorded as who set the password, for every role that may create", async () => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    const repository = fakeEmployeeRepository([employee({ id: "self-id", role: "tl", department_id: DEPARTMENT })]);
    const service = makeService(repository);

    await service.createEmployee(principalFor(role), { ...CREATE_INPUT, department_id: DEPARTMENT, role: "employee" });

    assert.equal(repository.calls.create[0].passwordSetByEmployeeId, "self-id", role);
  }
});

test("createEmployee: D41 -- an inactive employee gets a password too (they cannot sign in until activated anyway)", async () => {
  const repository = fakeEmployeeRepository();
  const service = makeService(repository);

  await service.createEmployee(principalFor("admin"), { ...CREATE_INPUT, department_id: DEPARTMENT, employment_status: "inactive" });

  assert.equal(repository.calls.create[0].passwordHash, hashOf("temp-pass-1234"));
  assert.equal(repository.calls.create[0].employmentStatus, "inactive");
});

// ---------------------------------------------------------------------------
// resetPassword: an admin or hr sets a new temporary password for an existing employee (D41)
// ---------------------------------------------------------------------------

test("resetPassword: admin sets a hashed temporary password for the employee's user, attributed to the admin", async () => {
  const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "target-user-id" })]);
  const userRepository = fakeUserRepository();

  await makeService(repository, { userRepository }).resetPassword(principalFor("admin"), "target-id", "new-temp-9999");

  assert.deepEqual(userRepository.calls.setTemporaryPassword, [
    { userId: "target-user-id", passwordHash: hashOf("new-temp-9999"), setByEmployeeId: "self-id" },
  ]);
  assert.equal(JSON.stringify(userRepository.calls).includes("new-temp-9999"), false, "the plain password goes no further than the service");
});

test("resetPassword: the role hierarchy is the rule -- admin may reset anyone but themselves", async () => {
  for (const targetRole of ["hr", "manager", "tl", "employee", "admin"]) {
    const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "u", role: targetRole })]);
    const userRepository = fakeUserRepository();

    await makeService(repository, { userRepository }).resetPassword(principalFor("admin"), "target-id", "new-temp-9999");

    assert.equal(userRepository.calls.setTemporaryPassword.length, 1, targetRole);
  }
});

test("resetPassword: hr may reset a manager, tl or employee", async () => {
  for (const targetRole of ["manager", "tl", "employee"]) {
    const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "u", role: targetRole })]);
    const userRepository = fakeUserRepository();

    await makeService(repository, { userRepository }).resetPassword(principalFor("hr"), "target-id", "new-temp-9999");

    assert.equal(userRepository.calls.setTemporaryPassword.length, 1, targetRole);
  }
});

test("resetPassword: hr may NOT reset an admin or another hr -- that would be taking over the account", async () => {
  for (const targetRole of ["admin", "hr"]) {
    const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "u", role: targetRole })]);
    const userRepository = fakeUserRepository();

    await assert.rejects(
      makeService(repository, { userRepository }).resetPassword(principalFor("hr"), "target-id", "new-temp-9999"),
      (error) => { assert.equal(error.statusCode, 403); assert.equal(error.code, "employee_scope_denied"); return true; },
      targetRole,
    );
    assert.equal(userRepository.calls.setTemporaryPassword.length, 0, targetRole);
  }
});

test("resetPassword: manager, tl and employee can never reset a password, not even their own team's", async () => {
  for (const role of ["manager", "tl", "employee"]) {
    const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "u", role: "employee" })]);
    const userRepository = fakeUserRepository();

    await assert.rejects(
      makeService(repository, { userRepository }).resetPassword(principalFor(role), "target-id", "new-temp-9999"),
      (error) => { assert.equal(error.statusCode, 403); assert.equal(error.code, "role_not_allowed"); return true; },
      role,
    );
    assert.equal(userRepository.calls.setTemporaryPassword.length, 0, role);
  }
});

test("resetPassword: nobody resets their OWN password (changing it asks for the current one; this does not)", async () => {
  const repository = fakeEmployeeRepository([employee({ id: "self-id", user_id: "u", role: "admin" })]);
  const userRepository = fakeUserRepository();

  await assert.rejects(
    makeService(repository, { userRepository }).resetPassword(principalFor("admin"), "self-id", "new-temp-9999"),
    (error) => { assert.equal(error.statusCode, 403); assert.equal(error.code, "self_reset_denied"); return true; },
  );
  assert.equal(userRepository.calls.setTemporaryPassword.length, 0);
});

test("resetPassword: a nonexistent employee is a 404, and nothing is written", async () => {
  const userRepository = fakeUserRepository();

  await assert.rejects(
    makeService(fakeEmployeeRepository([]), { userRepository }).resetPassword(principalFor("admin"), "missing-id", "new-temp-9999"),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
  assert.equal(userRepository.calls.setTemporaryPassword.length, 0);
});

test("resetPassword: a user row that vanished between the read and the write is a 404, not a silent success", async () => {
  const repository = fakeEmployeeRepository([employee({ id: "target-id", user_id: "u" })]);
  const userRepository = fakeUserRepository({ setTemporaryPasswordResult: false });

  await assert.rejects(
    makeService(repository, { userRepository }).resetPassword(principalFor("admin"), "target-id", "new-temp-9999"),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
});
