import assert from "node:assert/strict";
import test from "node:test";
import { createDepartmentRepository } from "../src/repositories/departmentRepository.js";

// No database. Fake client matches queries by substring/regex against a handler table, same
// shape as employeeRepository.test.js's fakeDatabase. Read-side role-gate coverage
// (listForPrincipal/findByIdForPrincipal) already lives in resourceRepositories.test.js --
// this file is the write path only.

function fakeDatabase(handlers) {
  const calls = [];
  async function query(text, values) {
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
  }
  const client = { query, release() {} };
  // Real pg.Pool supports both .query() (pool-level convenience, used by listForPrincipal/
  // findByIdForPrincipal and updateById's no-op short-circuit) and .connect() (manual, used
  // by every transactional write) -- the fake needs both for the same reason.
  return { calls, query, connect: async () => client };
}

const DEPARTMENT_ROW = Object.freeze({
  id: "dept-1", company_id: "company-1", name: "Engineering", description: null,
  status: "active", manager_employee_id: null,
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: happy path inserts, re-selects, and commits", async () => {
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO departments", { rows: [{ id: "dept-1" }] }],
    [/SELECT[\s\S]*FROM departments/, { rows: [DEPARTMENT_ROW] }],
  ]);
  const repository = createDepartmentRepository(database);

  const result = await repository.create({ name: "Engineering", description: null, status: "active" });

  assert.deepEqual(result, DEPARTMENT_ROW);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO departments"));
  assert.deepEqual(insert.values, ["company-1", "Engineering", null, "active"]);
});

test("create: never inserts manager_employee_id, even if present on the input object", async () => {
  // create()'s own destructured parameter list already drops it; this confirms that
  // guarantee holds at the SQL level too, not just by convention.
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO departments", { rows: [{ id: "dept-1" }] }],
    [/SELECT[\s\S]*FROM departments/, { rows: [DEPARTMENT_ROW] }],
  ]);
  const repository = createDepartmentRepository(database);

  await repository.create({ name: "Engineering", description: null, status: "active", manager_employee_id: "sneaky-id" });

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO departments"));
  assert.doesNotMatch(insert.text, /manager_employee_id/);
  assert.equal(insert.values.includes("sneaky-id"), false);
});

test("create: a duplicate name is translated to a clean 409, and the transaction is rolled back", async () => {
  const pgError = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "departments_name_unique" });
  const database = fakeDatabase([
    ["SELECT id FROM companies LIMIT 1", { rows: [{ id: "company-1" }] }],
    ["INSERT INTO departments", { throwError: pgError }],
  ]);
  const repository = createDepartmentRepository(database);

  await assert.rejects(
    repository.create({ name: "Engineering", description: null, status: "active" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "name_already_exists");
      return true;
    },
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// updateById
// ---------------------------------------------------------------------------

test("updateById: only touches columns present in changes", async () => {
  const database = fakeDatabase([
    ["UPDATE departments SET", { rows: [] }],
    [/SELECT[\s\S]*FROM departments/, { rows: [DEPARTMENT_ROW] }],
  ]);
  const repository = createDepartmentRepository(database);

  await repository.updateById("dept-1", { name: "Platform" });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE departments SET"));
  assert.match(update.text, /name = \$1/);
  assert.doesNotMatch(update.text, /description = /);
  assert.doesNotMatch(update.text, /status = /);
  assert.doesNotMatch(update.text, /manager_employee_id = /);
  assert.deepEqual(update.values, ["Platform", "dept-1"]);
});

test("updateById: an empty changes object skips the transaction entirely", async () => {
  const database = fakeDatabase([
    [/SELECT[\s\S]*FROM departments/, { rows: [DEPARTMENT_ROW] }],
  ]);
  const repository = createDepartmentRepository(database);

  const result = await repository.updateById("dept-1", {});

  assert.deepEqual(result, DEPARTMENT_ROW);
  assert.equal(database.calls.some((call) => call.text === "BEGIN"), false);
});

test("updateById: manager_employee_id may be set to null freely -- D15, no extra guard", async () => {
  const database = fakeDatabase([
    ["UPDATE departments SET", { rows: [] }],
    [/SELECT[\s\S]*FROM departments/, { rows: [{ ...DEPARTMENT_ROW, manager_employee_id: null }] }],
  ]);
  const repository = createDepartmentRepository(database);

  const result = await repository.updateById("dept-1", { manager_employee_id: null });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE departments SET"));
  assert.match(update.text, /manager_employee_id = \$1/);
  assert.deepEqual(update.values, [null, "dept-1"]);
  assert.equal(result.manager_employee_id, null);
});

test("updateById: an invalid manager_employee_id is translated to a clean 400", async () => {
  const pgError = Object.assign(new Error("fk violation"), {
    code: "23503", constraint: "departments_manager_employee_foreign_key",
  });
  const database = fakeDatabase([
    ["UPDATE departments SET", { throwError: pgError }],
  ]);
  const repository = createDepartmentRepository(database);

  await assert.rejects(
    repository.updateById("dept-1", { manager_employee_id: "not-in-this-department" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_manager");
      return true;
    },
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("updateById: returns null for a nonexistent department", async () => {
  const database = fakeDatabase([
    ["UPDATE departments SET", { rows: [] }],
    [/SELECT[\s\S]*FROM departments/, { rows: [] }],
  ]);
  const repository = createDepartmentRepository(database);

  const result = await repository.updateById("missing-id", { name: "Platform" });

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: zero live employees succeeds", async () => {
  const database = fakeDatabase([
    ["SELECT id FROM departments", { rows: [{ id: "dept-1" }] }],
    ["SELECT COUNT(*)::int AS count FROM employees", { rows: [{ count: 0 }] }],
    ["UPDATE departments SET deleted_at", { rows: [] }],
  ]);
  const repository = createDepartmentRepository(database);

  await repository.deleteById("dept-1");

  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: D26 -- live employees refuse with 409 and the exact count in the message", async () => {
  const database = fakeDatabase([
    ["SELECT id FROM departments", { rows: [{ id: "dept-1" }] }],
    ["SELECT COUNT(*)::int AS count FROM employees", { rows: [{ count: 3 }] }],
  ]);
  const repository = createDepartmentRepository(database);

  await assert.rejects(repository.deleteById("dept-1"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "department_has_employees");
    assert.match(error.message, /\b3\b/);
    return true;
  });
  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE departments SET deleted_at")), false);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a nonexistent department is a clean 404, not a crash", async () => {
  const database = fakeDatabase([
    ["SELECT id FROM departments", { rows: [] }],
  ]);
  const repository = createDepartmentRepository(database);

  await assert.rejects(repository.deleteById("missing-id"), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["SELECT id FROM departments", { rows: [{ id: "dept-1" }] }],
    ["SELECT COUNT(*)::int AS count FROM employees", { rows: [{ count: 0 }] }],
    ["UPDATE departments SET deleted_at", { throwError: boom }],
  ]);
  const repository = createDepartmentRepository(database);

  await assert.rejects(repository.deleteById("dept-1"), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});
