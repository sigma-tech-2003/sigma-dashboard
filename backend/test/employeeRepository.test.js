import assert from "node:assert/strict";
import test from "node:test";
import { createEmployeeRepository } from "../src/repositories/employeeRepository.js";

// No database. Each fake client matches queries by substring against a handler table, in
// order, so tests read as "when this statement runs, return/throw this" rather than
// depending on exact call-index bookkeeping.

function fakeDatabase(handlers) {
  const calls = [];
  const client = {
    async query(text, values) {
      const trimmed = text.trim();
      calls.push({ text: trimmed, values });
      for (const [matcher, response] of handlers) {
        const matches = typeof matcher === "string" ? trimmed.includes(matcher) : matcher.test(trimmed);
        if (!matches) continue;
        const resolved = typeof response === "function" ? response(values) : response;
        if (resolved?.throwError) throw resolved.throwError;
        return resolved ?? { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { calls, connect: async () => client };
}

const JOINED_ROW = Object.freeze({
  id: "employee-1", user_id: "user-1", company_id: "company-1", department_id: "dept-1",
  team_lead_id: null, employee_number: "EMP-0001", full_name: "New Hire", phone: null,
  position_title: "Engineer", employment_status: "active", joined_on: "2026-09-25",
  basic: 50000, allowances: 0, role: "employee", email: "new.hire@example.com",
});

const CREATE_INPUT = Object.freeze({
  email: "new.hire@example.com", role: "employee", fullName: "New Hire", phone: null,
  departmentId: "dept-1", positionTitle: "Engineer", joinedOn: "2026-09-25",
  basic: 50000, allowances: 0, teamLeadId: null,
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: happy path inserts users then employees, in one transaction, and re-fetches the joined row", async () => {
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO users", { rows: [{ id: "user-1" }] }],
    ["next_employee_number()", { rows: [{ employee_number: "EMP-0001" }] }],
    ["INSERT INTO employees", { rows: [{ id: "employee-1" }] }],
    [/SELECT[\s\S]*FROM employees[\s\S]*JOIN users/, { rows: [JOINED_ROW] }],
  ]);
  const repository = createEmployeeRepository(database);

  const result = await repository.create(CREATE_INPUT);

  assert.deepEqual(result, JOINED_ROW);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const userInsert = database.calls.find((call) => call.text.includes("INSERT INTO users"));
  assert.match(userInsert.text, /status\)/); // status column present in the insert list
  assert.match(userInsert.text, /'invited'/); // ...and hard-coded to 'invited'
  assert.doesNotMatch(userInsert.text, /password_hash/i, "create must never set a password");
  assert.deepEqual(userInsert.values, ["company-1", "new.hire@example.com", "employee"]);

  const employeeInsert = database.calls.find((call) => call.text.includes("INSERT INTO employees"));
  assert.deepEqual(employeeInsert.values, [
    "user-1", "company-1", "dept-1", null, "EMP-0001",
    "New Hire", null, "Engineer", "2026-09-25", 50000, 0,
  ]);
});

test("create: a duplicate email is translated to a clean 409, and the transaction is rolled back", async () => {
  const pgError = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "users_email_unique" });
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO users", { throwError: pgError }],
  ]);
  const repository = createEmployeeRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "email_already_exists");
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: an invalid department_id is translated to a clean 400", async () => {
  const pgError = Object.assign(new Error("fk violation"), {
    code: "23503", constraint: "employees_department_company_foreign_key",
  });
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO users", { rows: [{ id: "user-1" }] }],
    ["next_employee_number()", { rows: [{ employee_number: "EMP-0001" }] }],
    ["INSERT INTO employees", { throwError: pgError }],
  ]);
  const repository = createEmployeeRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "invalid_department");
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// updateById
// ---------------------------------------------------------------------------

test("updateById: changes touching only employees columns never touch users", async () => {
  const database = fakeDatabase([
    ["UPDATE employees SET", { rows: [] }],
    [/SELECT[\s\S]*FROM employees[\s\S]*JOIN users/, { rows: [JOINED_ROW] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.updateById("employee-1", { phone: "0300", basic: 60000 });

  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE users")), false);
  const employeeUpdate = database.calls.find((call) => call.text.startsWith("UPDATE employees SET"));
  assert.match(employeeUpdate.text, /phone = \$1/);
  assert.match(employeeUpdate.text, /basic = \$2/);
  assert.match(employeeUpdate.text, /WHERE id = \$3 AND deleted_at IS NULL/);
  assert.deepEqual(employeeUpdate.values, ["0300", 60000, "employee-1"]);
});

test("updateById: changes touching only users columns fetch user_id first, then never touch employees", async () => {
  const database = fakeDatabase([
    ["SELECT user_id FROM employees", { rows: [{ user_id: "user-1" }] }],
    ["UPDATE users SET", { rows: [] }],
    [/SELECT[\s\S]*FROM employees[\s\S]*JOIN users/, { rows: [JOINED_ROW] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.updateById("employee-1", { role: "manager" });

  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE employees SET")), false);
  const userUpdate = database.calls.find((call) => call.text.startsWith("UPDATE users SET"));
  assert.match(userUpdate.text, /role = \$1/);
  assert.deepEqual(userUpdate.values, ["manager", "user-1"]);
});

test("updateById: a change spanning both tables issues both updates in the same transaction", async () => {
  const database = fakeDatabase([
    ["UPDATE employees SET", { rows: [] }],
    ["SELECT user_id FROM employees", { rows: [{ user_id: "user-1" }] }],
    ["UPDATE users SET", { rows: [] }],
    [/SELECT[\s\S]*FROM employees[\s\S]*JOIN users/, { rows: [JOINED_ROW] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.updateById("employee-1", { full_name: "Renamed", role: "manager" });

  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
  assert.ok(database.calls.some((call) => call.text.startsWith("UPDATE employees SET")));
  assert.ok(database.calls.some((call) => call.text.startsWith("UPDATE users SET")));
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: no replacement just soft-deletes both rows -- no role or team_lead_id writes", async () => {
  const database = fakeDatabase([
    ["SELECT id, user_id FROM employees", { rows: [{ id: "employee-1", user_id: "user-1" }] }],
    ["UPDATE employees SET deleted_at", { rows: [] }],
    ["UPDATE users SET deleted_at", { rows: [] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.deleteById("employee-1", {});

  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
  assert.equal(database.calls.some((call) => call.text.includes("role = 'tl'")), false);
  assert.equal(database.calls.some((call) => call.text.includes("team_lead_id")), false);

  const employeeDelete = database.calls.find((call) => call.text.includes("UPDATE employees SET deleted_at"));
  assert.deepEqual(employeeDelete.values, ["employee-1"]);
  const userDelete = database.calls.find((call) => call.text.includes("UPDATE users SET deleted_at"));
  assert.deepEqual(userDelete.values, ["user-1"]);
});

test("deleteById: with a replacement, promotes them, clears their team_lead_id, reassigns members, then deletes the target", async () => {
  const database = fakeDatabase([
    [/SELECT (?:id, )?user_id FROM employees/, (values) => {
      if (values[0] === "employee-1") return { rows: [{ id: "employee-1", user_id: "user-1" }] };
      if (values[0] === "replacement-1") return { rows: [{ user_id: "user-replacement" }] };
      return { rows: [] };
    }],
    ["UPDATE users SET role = 'tl'", { rows: [] }],
    ["UPDATE employees SET team_lead_id = NULL", { rows: [] }],
    ["UPDATE employees SET team_lead_id = $1 WHERE id = ANY", { rows: [] }],
    ["UPDATE employees SET deleted_at", { rows: [] }],
    ["UPDATE users SET deleted_at", { rows: [] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.deleteById("employee-1", {
    replacementTeamLeadId: "replacement-1",
    reassignedMemberIds: ["member-2", "member-3"],
  });

  const texts = database.calls.map((call) => call.text);
  const promoteIndex = texts.findIndex((text) => text.includes("role = 'tl'"));
  const clearIndex = texts.findIndex((text) => text.includes("team_lead_id = NULL"));
  const reassignIndex = texts.findIndex((text) => text.includes("ANY"));
  const deleteEmployeeIndex = texts.findIndex((text) => text.includes("UPDATE employees SET deleted_at"));
  const deleteUserIndex = texts.findIndex((text) => text.includes("UPDATE users SET deleted_at"));

  // Reassignment happens before the target itself is deleted.
  assert.ok(promoteIndex < deleteEmployeeIndex);
  assert.ok(clearIndex < deleteEmployeeIndex);
  assert.ok(reassignIndex < deleteEmployeeIndex);
  assert.ok(deleteEmployeeIndex < deleteUserIndex);

  const promoteCall = database.calls[promoteIndex];
  assert.deepEqual(promoteCall.values, ["user-replacement"]);
  const reassignCall = database.calls[reassignIndex];
  assert.deepEqual(reassignCall.values, ["replacement-1", ["member-2", "member-3"]]);
  assert.equal(texts.at(0), "BEGIN");
  assert.equal(texts.at(-1), "COMMIT");
});

test("deleteById: with a replacement but no other members, skips the reassignment query entirely", async () => {
  const database = fakeDatabase([
    [/SELECT (?:id, )?user_id FROM employees/, (values) => {
      if (values[0] === "employee-1") return { rows: [{ id: "employee-1", user_id: "user-1" }] };
      return { rows: [{ user_id: "user-replacement" }] };
    }],
    ["UPDATE users SET role = 'tl'", { rows: [] }],
    ["UPDATE employees SET team_lead_id = NULL", { rows: [] }],
    ["UPDATE employees SET deleted_at", { rows: [] }],
    ["UPDATE users SET deleted_at", { rows: [] }],
  ]);
  const repository = createEmployeeRepository(database);

  await repository.deleteById("employee-1", {
    replacementTeamLeadId: "replacement-1",
    reassignedMemberIds: [],
  });

  assert.equal(database.calls.some((call) => call.text.includes("ANY")), false);
});

test("deleteById: a missing target is a clean 404, not a crash, and rolls back", async () => {
  const database = fakeDatabase([
    ["SELECT id, user_id FROM employees", { rows: [] }],
  ]);
  const repository = createEmployeeRepository(database);

  await assert.rejects(repository.deleteById("missing-id", {}), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a failure partway through the transaction rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["SELECT id, user_id FROM employees", { rows: [{ id: "employee-1", user_id: "user-1" }] }],
    ["UPDATE employees SET deleted_at", { throwError: boom }],
  ]);
  const repository = createEmployeeRepository(database);

  await assert.rejects(repository.deleteById("employee-1", {}), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});
