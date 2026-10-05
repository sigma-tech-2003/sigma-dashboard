import assert from "node:assert/strict";
import test from "node:test";
import { createPayrollRepository } from "../src/repositories/payrollRepository.js";

// No database. Fake client matches queries by substring/regex against a handler table, same
// shape as attendanceRepository.test.js's fakeDatabase. Read-side scope coverage lives in
// resourceRepositories.test.js -- this file is the write path, plus the SQL shape the writes and
// the float8 money columns depend on. The real constraint names, the real guard behaviour and
// pg's actual number types are proved against a database by scripts/e2e-payroll.js.

function fakeDatabase(handlers) {
  const calls = [];
  async function run(via, text, values) {
    const trimmed = text.trim();
    calls.push({ via, text: trimmed, values });
    for (const [matcher, response] of handlers) {
      const matches = typeof matcher === "string" ? trimmed.includes(matcher) : matcher.test(trimmed);
      if (!matches) continue;
      const resolved = typeof response === "function" ? response(values) : response;
      if (resolved?.throwError) throw resolved.throwError;
      return resolved ?? { rows: [] };
    }
    return { rows: [] };
  }
  // `via` distinguishes the transaction's client from the pool: the duplicate-period lookup must
  // run on the pool, after ROLLBACK -- a failed transaction is aborted and cannot query.
  const client = { query: (text, values) => run("client", text, values), release() {} };
  return {
    calls,
    query: (text, values) => run("pool", text, values),
    connect: async () => client,
  };
}

const indexOfCall = (database, matcher) => database.calls.findIndex((call) => (
  typeof matcher === "string" ? call.text.includes(matcher) : matcher.test(call.text)
));
const countOf = (database, text) => database.calls.filter((call) => call.text === text).length;

const PAYROLL_ROW = Object.freeze({
  id: "pay-1", employee_id: "emp-1", period_year: 2026, period_month: 9,
  basic: 50000, allowances: 5000, bonus: 0, deductions: 0, gross: 55000, tax: 250, net: 54750, status: "processed",
});

const SELECT_PAYROLL = /SELECT[\s\S]*FROM payroll[\s\S]*WHERE payroll\.id = \$1/;
const MONEY_COLUMNS = ["basic", "allowances", "bonus", "deductions", "gross", "tax", "net"];

const pgError = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

const CREATE_INPUT = Object.freeze({
  employee_id: "emp-1", period_year: 2026, period_month: 9,
  basic: "50000.00", allowances: 5000, bonus: 0, deductions: 0, status: "processed",
});

// ---------------------------------------------------------------------------
// Amounts as JSON numbers (D28)
// ---------------------------------------------------------------------------

test("every read selects all seven money columns as float8, so responses carry numbers, not strings", async () => {
  // pg returns numeric as a string ("50000.00"); the frontend adds these values and would
  // concatenate them. float8 makes pg hand back a JS number.
  const database = fakeDatabase([[/FROM payroll/, { rows: [] }]]);
  const repository = createPayrollRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal("pay-1", principal);
  await repository.findById("pay-1");

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    for (const column of MONEY_COLUMNS) {
      assert.match(text, new RegExp(`payroll\\.${column}::float8 AS ${column}\\b`), column);
    }
  }
});

test("write re-selects use the same float8 column list as the reads", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.create(CREATE_INPUT);

  const select = database.calls.find((call) => call.text.startsWith("SELECT"));
  for (const column of MONEY_COLUMNS) {
    assert.match(select.text, new RegExp(`payroll\\.${column}::float8 AS ${column}\\b`), column);
  }
});

test("the cast is for the money columns only -- ids, period and status are left alone", async () => {
  const database = fakeDatabase([[/FROM payroll/, { rows: [] }]]);
  await createPayrollRepository(database).findById("pay-1");

  const { text } = database.calls[0];
  assert.doesNotMatch(text, /period_year::float8|period_month::float8|status::float8|employee_id::float8/);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: happy path inserts, re-selects, and commits", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  const result = await repository.create(CREATE_INPUT);

  assert.deepEqual(result, PAYROLL_ROW);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO payroll"));
  assert.deepEqual(insert.values, ["emp-1", 2026, 9, "50000.00", 5000, 0, 0, "processed"]);
});

test("create: the INSERT names no generated or server-owned column -- gross, tax, net, timestamps, deleted_*", async () => {
  // Writing a generated column is a Postgres error, and the timestamps and deleter are the
  // server's. Even if smuggled onto the input object they must not reach the SQL.
  const database = fakeDatabase([
    ["INSERT INTO payroll", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.create({
    ...CREATE_INPUT, gross: 1, tax: 2, net: 3, created_at: "2000-01-01", updated_at: "2000-01-01",
    deleted_at: "2000-01-01", deleted_by_employee_id: "emp-9",
  });

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO payroll"));
  const columnList = insert.text.slice(0, insert.text.indexOf("VALUES"));
  assert.doesNotMatch(columnList, /gross|tax|net|created_at|updated_at|deleted/);
  assert.equal(insert.values.length, 8);
});

test("create: D28 -- a duplicate period is a 409 payroll_already_recorded carrying the existing id", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [{ id: "existing-pay" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "payroll_already_recorded");
    assert.deepEqual(error.details, { existing_id: "existing-pay" });
    return true;
  });
});

test("create: the existing-id lookup runs on the pool AFTER the rollback, keyed by the payload's employee and period", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [{ id: "existing-pay" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT));

  const rollback = indexOfCall(database, "ROLLBACK");
  const lookup = indexOfCall(database, "conflicting.id");
  assert.ok(rollback >= 0 && lookup > rollback, "the lookup must come after ROLLBACK");
  assert.equal(database.calls[lookup].via, "pool");
  // [employeeId, periodYear, periodMonth, excludeId]
  assert.deepEqual(database.calls[lookup].values, ["emp-1", 2026, 9, null]);
});

test("create: a duplicate whose occupant has vanished still 409s, just without an id", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => {
    assert.equal(error.code, "payroll_already_recorded");
    assert.equal(error.details, undefined);
    return true;
  });
});

test("create: a failing lookup does not mask the 409", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { throwError: new Error("pool exhausted") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.create(CREATE_INPUT),
    (error) => error.statusCode === 409 && error.code === "payroll_already_recorded",
  );
});

test("create: a unique violation on some other constraint is a generic 409 conflict, with no lookup", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23505", "payroll_pkey") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => error.statusCode === 409 && error.code === "conflict");
  assert.equal(indexOfCall(database, "conflicting.id"), -1);
});

test("create: a nonexistent employee is a clean 400 invalid_employee, and the transaction is rolled back", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23503", "payroll_employee_id_fkey") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.create(CREATE_INPUT),
    (error) => error.statusCode === 400 && error.code === "invalid_employee",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: any other foreign-key violation is a generic 400 invalid_reference", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23503", "something_else_fkey") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => error.statusCode === 400 && error.code === "invalid_reference");
});

test("create: the year and month CHECKs are a 400 invalid_period", async () => {
  for (const constraint of ["payroll_year_range", "payroll_month_range"]) {
    const database = fakeDatabase([
      ["INSERT INTO payroll", { throwError: pgError("23514", constraint) }],
    ]);
    const repository = createPayrollRepository(database);

    await assert.rejects(
      repository.create({ ...CREATE_INPUT, period_month: 13 }),
      (error) => error.statusCode === 400 && error.code === "invalid_period",
      constraint,
    );
  }
});

test("create: the non-negative CHECK is a 400 invalid_amounts", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23514", "payroll_amounts_non_negative") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.create({ ...CREATE_INPUT, bonus: -1 }),
    (error) => error.statusCode === 400 && error.code === "invalid_amounts" && /negative/.test(error.message),
  );
});

test("create: numeric overflow (22003) is a 400 invalid_amounts, not an opaque 500", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("22003", undefined) }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.create({ ...CREATE_INPUT, basic: 1e12 }),
    (error) => error.statusCode === 400 && error.code === "invalid_amounts" && /too large/.test(error.message),
  );
});

test("create: an unrecognised CHECK is a generic 400 invalid_request", async () => {
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: pgError("23514", "payroll_deleted_by_requires_deleted_at") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => error.statusCode === 400 && error.code === "invalid_request");
});

test("create: an unrecognised error is rethrown unchanged, not papered over", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["INSERT INTO payroll", { throwError: boom }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.create(CREATE_INPUT), (error) => error === boom);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// updateById
// ---------------------------------------------------------------------------

test("updateById: only touches columns present in changes", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.updateById("pay-1", { bonus: 500, deductions: 25 });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll SET"));
  assert.match(update.text, /bonus = \$1/);
  assert.match(update.text, /deductions = \$2/);
  // Only the SET clause: the WHERE legitimately says status = 'draft'.
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  for (const untouched of ["employee_id", "period_year", "period_month", "basic", "allowances", "status"]) {
    assert.doesNotMatch(setClause, new RegExp(`\\b${untouched} = `), untouched);
  }
  assert.deepEqual(update.values, [500, 25, "pay-1"]);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("updateById: a draft can be promoted -- status is a writable column", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.updateById("pay-1", { status: "processed", bonus: 100 });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll SET"));
  // Columns are emitted in the repository's fixed order, so bonus precedes status.
  assert.match(update.text, /bonus = \$1/);
  assert.match(update.text, /status = \$2/);
  assert.deepEqual(update.values, [100, "processed", "pay-1"]);
});

test("updateById: never writes gross, tax, net, timestamps or deleted_* even if smuggled in", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.updateById("pay-1", {
    bonus: 1, gross: 9, tax: 9, net: 9, updated_at: "2000-01-01", created_at: "2000-01-01",
    deleted_at: "2000-01-01", deleted_by_employee_id: "emp-9",
  });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll SET"));
  // Only the SET clause: the WHERE legitimately mentions deleted_at.
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  assert.doesNotMatch(setClause, /gross|tax|net|updated_at|created_at|deleted_at|deleted_by/);
  assert.deepEqual(update.values, [1, "pay-1"]);
});

test("updateById: D28 -- the UPDATE itself is guarded on status = 'draft' and deleted_at IS NULL", async () => {
  // Processed immutability is enforced atomically in SQL, not only by the service's earlier read.
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [{ id: "pay-1" }] }],
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.updateById("pay-1", { bonus: 1 });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll SET"));
  assert.match(update.text, /WHERE id = \$2 AND deleted_at IS NULL AND status = 'draft'/);
  assert.match(update.text, /RETURNING id/);
});

test("updateById: D28 -- a processed record is a 409 payroll_not_editable from the repository itself", async () => {
  // The guarded UPDATE touches no row; the follow-up SELECT finds the record still live, so it
  // exists but is not a draft.
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [] }],
    [SELECT_PAYROLL, { rows: [{ ...PAYROLL_ROW, status: "processed" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.updateById("pay-1", { bonus: 1 }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "payroll_not_editable");
    return true;
  });
  assert.equal(countOf(database, "COMMIT"), 0, "nothing is committed");
  assert.equal(countOf(database, "ROLLBACK"), 1, "rolled back exactly once");
});

test("updateById: a record that is gone (or deleted) is null, not a 409, and rolls back", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { rows: [] }],
    [SELECT_PAYROLL, { rows: [] }],
  ]);
  const repository = createPayrollRepository(database);

  assert.equal(await repository.updateById("missing", { bonus: 1 }), null);
  assert.equal(countOf(database, "COMMIT"), 0);
  assert.equal(countOf(database, "ROLLBACK"), 1);
});

test("updateById: an empty changes object skips the transaction entirely", async () => {
  const database = fakeDatabase([
    [SELECT_PAYROLL, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  const result = await repository.updateById("pay-1", {});

  assert.deepEqual(result, PAYROLL_ROW);
  assert.equal(database.calls.some((call) => call.text === "BEGIN"), false);
});

test("updateById: D28 -- moving a draft onto an occupied period is the same 409 with the occupant's id", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-pay" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.updateById("pay-1", { period_month: 8 }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "payroll_already_recorded");
    assert.deepEqual(error.details, { existing_id: "occupant-pay" });
    return true;
  });
});

test("updateById: the conflict lookup defaults unchanged employee/year to the draft's own and excludes the draft itself", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-pay" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.updateById("pay-1", { period_month: 8 }));

  const lookup = database.calls[indexOfCall(database, "conflicting.id")];
  assert.equal(lookup.via, "pool");
  // [employeeId (null: unchanged), periodYear (null: unchanged), periodMonth, excludeId]
  assert.deepEqual(lookup.values, [null, null, 8, "pay-1"]);
  assert.match(lookup.text, /conflicting\.id <> \$4::uuid/);
  assert.ok(indexOfCall(database, "ROLLBACK") < indexOfCall(database, "conflicting.id"));
});

test("updateById: changing employee and period together passes all the new values to the lookup", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { throwError: pgError("23505", "payroll_employee_period_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-pay" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.updateById("pay-1", { employee_id: "emp-2", period_year: 2025, period_month: 12 }));

  const lookup = database.calls[indexOfCall(database, "conflicting.id")];
  assert.deepEqual(lookup.values, ["emp-2", 2025, 12, "pay-1"]);
});

test("updateById: a nonexistent employee_id is a clean 400 invalid_employee", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { throwError: pgError("23503", "payroll_employee_id_fkey") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.updateById("pay-1", { employee_id: "ghost" }),
    (error) => error.statusCode === 400 && error.code === "invalid_employee",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("updateById: a failure that is not an HttpError still rolls back and is translated", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll SET", { throwError: pgError("23514", "payroll_amounts_non_negative") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.updateById("pay-1", { bonus: -5 }),
    (error) => error.statusCode === 400 && error.code === "invalid_amounts",
  );
  assert.equal(countOf(database, "ROLLBACK"), 1);
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: D28 -- soft deletes, setting deleted_at and recording the deleter", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll", { rows: [{ id: "pay-1" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.deleteById("pay-1", "deleter-emp");

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll"));
  assert.match(update.text, /deleted_at = now\(\)/);
  assert.match(update.text, /deleted_by_employee_id = \$2/);
  assert.match(update.text, /WHERE id = \$1 AND deleted_at IS NULL/);
  assert.deepEqual(update.values, ["pay-1", "deleter-emp"]);
  assert.equal(database.calls.some((call) => /^DELETE\b/i.test(call.text)), false, "never a hard DELETE");
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: D28 -- any status may be deleted; the UPDATE has no status condition", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll", { rows: [{ id: "pay-1" }] }],
  ]);
  const repository = createPayrollRepository(database);

  await repository.deleteById("pay-1", "deleter-emp");

  const update = database.calls.find((call) => call.text.startsWith("UPDATE payroll"));
  assert.doesNotMatch(update.text, /status/);
});

test("deleteById: a nonexistent or already-deleted record is a clean 404, and rolls back", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll", { rows: [] }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.deleteById("missing", "deleter-emp"), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["UPDATE payroll", { throwError: boom }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(repository.deleteById("pay-1", "deleter-emp"), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: an unknown deleter id is a 400 invalid_reference rather than a 500", async () => {
  const database = fakeDatabase([
    ["UPDATE payroll", { throwError: pgError("23503", "payroll_deleted_by_employee_id_fkey") }],
  ]);
  const repository = createPayrollRepository(database);

  await assert.rejects(
    repository.deleteById("pay-1", "ghost"),
    (error) => error.statusCode === 400 && error.code === "invalid_reference",
  );
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

test("findById: live records only, unscoped -- writers are company-wide", async () => {
  const database = fakeDatabase([
    [/FROM payroll/, { rows: [PAYROLL_ROW] }],
  ]);
  const repository = createPayrollRepository(database);

  const result = await repository.findById("pay-1");

  assert.deepEqual(result, PAYROLL_ROW);
  const { text, values } = database.calls[0];
  assert.match(text, /payroll\.id = \$1 AND payroll\.deleted_at IS NULL/);
  assert.doesNotMatch(text, /employees|JOIN/);
  assert.deepEqual(values, ["pay-1"]);
});

test("findById: returns null when there is no live record", async () => {
  const database = fakeDatabase([[/FROM payroll/, { rows: [] }]]);
  const repository = createPayrollRepository(database);

  assert.equal(await repository.findById("missing"), null);
});
