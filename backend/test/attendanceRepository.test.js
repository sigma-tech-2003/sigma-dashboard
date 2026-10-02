import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceRepository } from "../src/repositories/attendanceRepository.js";

// No database. Fake client matches queries by substring/regex against a handler table, same
// shape as departmentRepository.test.js's fakeDatabase. Read-side scope coverage
// (listForPrincipal/findByIdForPrincipal) lives in resourceRepositories.test.js -- this file is
// the write path, plus the SQL shape the new write methods and the to_char reads depend on.

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
  // `via` distinguishes the transaction's client from the pool: the duplicate-day lookup must
  // run on the pool, after ROLLBACK -- a failed transaction is aborted and cannot query.
  const client = { query: (text, values) => run("client", text, values), release() {} };
  return {
    calls,
    query: (text, values) => run("pool", text, values),
    connect: async () => client,
  };
}

const textsOf = (database) => database.calls.map((call) => call.text);
const indexOfCall = (database, matcher) => database.calls.findIndex((call) => (
  typeof matcher === "string" ? call.text.includes(matcher) : matcher.test(call.text)
));

const ATTENDANCE_ROW = Object.freeze({
  id: "att-1", employee_id: "emp-1", work_date: "2026-10-01", status: "present",
  check_in: "09:00", check_out: "17:00", notes: null,
});

const SELECT_ATTENDANCE = /SELECT[\s\S]*FROM attendance[\s\S]*WHERE attendance\.id = \$1/;

const pgError = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: happy path inserts, re-selects, and commits", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { rows: [{ id: "att-1" }] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  const result = await repository.create({
    employee_id: "emp-1", work_date: "2026-10-01", status: "present", check_in: "09:00", check_out: "17:00", notes: "on time",
  });

  assert.deepEqual(result, ATTENDANCE_ROW);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO attendance"));
  assert.deepEqual(insert.values, ["emp-1", "2026-10-01", "present", "09:00", "17:00", "on time"]);
});

test("create: never writes created_at, updated_at or the deleted_* columns -- the server owns them (D27)", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { rows: [{ id: "att-1" }] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.create({
    employee_id: "emp-1", work_date: "2026-10-01", status: "present",
    created_at: "2000-01-01", updated_at: "2000-01-01", deleted_at: "2000-01-01",
  });

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO attendance"));
  assert.doesNotMatch(insert.text, /created_at|updated_at|deleted_at|deleted_by/);
  assert.equal(insert.values.includes("2000-01-01"), false);
});

test("create: omitted times and notes are inserted as null", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { rows: [{ id: "att-1" }] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "absent" });

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO attendance"));
  assert.deepEqual(insert.values, ["emp-1", "2026-10-01", "absent", null, null, null]);
});

test("create: D9 -- a duplicate day is a 409 attendance_already_recorded carrying the existing id", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [{ id: "existing-att" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "attendance_already_recorded");
      assert.deepEqual(error.details, { existing_id: "existing-att" });
      return true;
    },
  );
});

test("create: the existing-id lookup runs on the pool AFTER the rollback, keyed by the payload's employee and day", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [{ id: "existing-att" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }));

  const rollback = indexOfCall(database, "ROLLBACK");
  const lookup = indexOfCall(database, "conflicting.id");
  assert.ok(rollback >= 0 && lookup > rollback, "the lookup must come after ROLLBACK");
  assert.equal(database.calls[lookup].via, "pool");
  assert.deepEqual(database.calls[lookup].values, ["emp-1", "2026-10-01", null]);
});

test("create: a duplicate whose occupant has vanished still 409s, just without an id", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => {
      assert.equal(error.code, "attendance_already_recorded");
      assert.equal(error.details, undefined);
      return true;
    },
  );
});

test("create: a failing lookup does not mask the 409", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { throwError: new Error("pool exhausted") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => error.statusCode === 409 && error.code === "attendance_already_recorded",
  );
});

test("create: a unique violation on some other constraint is a generic 409 conflict", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23505", "attendance_pkey") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => error.statusCode === 409 && error.code === "conflict",
  );
  assert.equal(indexOfCall(database, "conflicting.id"), -1, "no lookup for an unrelated constraint");
});

test("create: a nonexistent employee is a clean 400 invalid_employee, and the transaction is rolled back", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23503", "attendance_employee_id_fkey") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "ghost", work_date: "2026-10-01", status: "present" }),
    (error) => error.statusCode === 400 && error.code === "invalid_employee",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: any other foreign-key violation is a generic 400 invalid_reference", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23503", "something_else_fkey") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => error.statusCode === 400 && error.code === "invalid_reference",
  );
});

test("create: attendance_times_ordered is a 400 invalid_times about check_out", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23514", "attendance_times_ordered") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present", check_in: "17:00", check_out: "09:00" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_times");
      assert.match(error.message, /check_out must be later than check_in/);
      return true;
    },
  );
});

test("create: attendance_absent_has_no_times is a 400 invalid_times about absent/leave records", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23514", "attendance_absent_has_no_times") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "absent", check_in: "09:00" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_times");
      assert.match(error.message, /Absent and leave records/);
      return true;
    },
  );
});

test("create: an unrecognised CHECK is a generic 400 invalid_request", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: pgError("23514", "attendance_timestamps_ordered") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => error.statusCode === 400 && error.code === "invalid_request",
  );
});

test("create: an unrecognised error is rethrown unchanged, not papered over", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["INSERT INTO attendance", { throwError: boom }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" }),
    (error) => error === boom,
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// updateById
// ---------------------------------------------------------------------------

test("updateById: only touches columns present in changes", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { rows: [] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.updateById("att-1", { status: "late", check_in: "10:15" });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE attendance SET"));
  assert.match(update.text, /status = \$1/);
  assert.match(update.text, /check_in = \$2/);
  assert.doesNotMatch(update.text, /employee_id = /);
  assert.doesNotMatch(update.text, /work_date = /);
  assert.doesNotMatch(update.text, /check_out = /);
  assert.doesNotMatch(update.text, /notes = /);
  assert.deepEqual(update.values, ["late", "10:15", "att-1"]);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("updateById: never writes updated_at, created_at or the deleted_* columns, even if smuggled in", async () => {
  // updated_at belongs to the attendance_set_updated_at trigger; deleted_* belong to deleteById.
  const database = fakeDatabase([
    ["UPDATE attendance SET", { rows: [] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.updateById("att-1", {
    notes: "x", updated_at: "2000-01-01", created_at: "2000-01-01", deleted_at: "2000-01-01", deleted_by_employee_id: "emp-9",
  });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE attendance SET"));
  // Only the SET clause: the WHERE legitimately mentions deleted_at.
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  assert.doesNotMatch(setClause, /updated_at|created_at|deleted_at|deleted_by/);
  assert.deepEqual(update.values, ["x", "att-1"]);
});

test("updateById: only a live record is updatable (deleted_at IS NULL in the WHERE)", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { rows: [] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.updateById("att-1", { notes: "x" });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE attendance SET"));
  assert.match(update.text, /WHERE id = \$2 AND deleted_at IS NULL/);
});

test("updateById: a null can clear a time or the notes", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { rows: [] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.updateById("att-1", { check_out: null, notes: null });

  const update = database.calls.find((call) => call.text.startsWith("UPDATE attendance SET"));
  assert.deepEqual(update.values, [null, null, "att-1"]);
});

test("updateById: an empty changes object skips the transaction entirely", async () => {
  const database = fakeDatabase([
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  const result = await repository.updateById("att-1", {});

  assert.deepEqual(result, ATTENDANCE_ROW);
  assert.equal(database.calls.some((call) => call.text === "BEGIN"), false);
});

test("updateById: returns null for a nonexistent or deleted record", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { rows: [] }],
    [SELECT_ATTENDANCE, { rows: [] }],
  ]);
  const repository = createAttendanceRepository(database);

  assert.equal(await repository.updateById("missing", { notes: "x" }), null);
});

test("updateById: D9 -- moving onto an occupied day is the same 409 with the occupant's id", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-att" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.updateById("att-1", { work_date: "2026-09-30" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "attendance_already_recorded");
      assert.deepEqual(error.details, { existing_id: "occupant-att" });
      return true;
    },
  );
});

test("updateById: the conflict lookup defaults an unchanged employee_id to the record's own, and excludes the record itself", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-att" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(repository.updateById("att-1", { work_date: "2026-09-30" }));

  const lookup = database.calls[indexOfCall(database, "conflicting.id")];
  assert.equal(lookup.via, "pool");
  // [employeeId (null: unchanged), workDate, excludeId]
  assert.deepEqual(lookup.values, [null, "2026-09-30", "att-1"]);
  assert.match(lookup.text, /conflicting\.id <> \$3::uuid/);
  assert.ok(indexOfCall(database, "ROLLBACK") < indexOfCall(database, "conflicting.id"));
});

test("updateById: re-attributing onto an employee who already has that day passes both new values to the lookup", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { throwError: pgError("23505", "attendance_employee_date_unique") }],
    ["conflicting.id", { rows: [{ id: "occupant-att" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(repository.updateById("att-1", { employee_id: "emp-2", work_date: "2026-09-30" }));

  const lookup = database.calls[indexOfCall(database, "conflicting.id")];
  assert.deepEqual(lookup.values, ["emp-2", "2026-09-30", "att-1"]);
});

test("updateById: a nonexistent employee_id is a clean 400 invalid_employee", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance SET", { throwError: pgError("23503", "attendance_employee_id_fkey") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.updateById("att-1", { employee_id: "ghost" }),
    (error) => error.statusCode === 400 && error.code === "invalid_employee",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("updateById: a status-only PATCH that collides with stored times is a clean 400 invalid_times", async () => {
  // The merged-state conflict a partial payload cannot see (status -> absent while the stored
  // record still has check-in/out): the database CHECK catches it, the repository translates it.
  const database = fakeDatabase([
    ["UPDATE attendance SET", { throwError: pgError("23514", "attendance_absent_has_no_times") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.updateById("att-1", { status: "absent" }),
    (error) => error.statusCode === 400 && error.code === "invalid_times",
  );
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: D27 -- soft deletes, setting deleted_at and recording the deleter", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance", { rows: [{ id: "att-1" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.deleteById("att-1", "deleter-emp");

  const update = database.calls.find((call) => call.text.startsWith("UPDATE attendance"));
  assert.match(update.text, /deleted_at = now\(\)/);
  assert.match(update.text, /deleted_by_employee_id = \$2/);
  assert.match(update.text, /WHERE id = \$1 AND deleted_at IS NULL/);
  assert.deepEqual(update.values, ["att-1", "deleter-emp"]);
  assert.equal(database.calls.some((call) => /^DELETE\b/i.test(call.text)), false, "never a hard DELETE");
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: a nonexistent or already-deleted record is a clean 404, and rolls back", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance", { rows: [] }],
  ]);
  const repository = createAttendanceRepository(database);

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
    ["UPDATE attendance", { throwError: boom }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(repository.deleteById("att-1", "deleter-emp"), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: an unknown deleter id is a 400 invalid_reference rather than a 500", async () => {
  const database = fakeDatabase([
    ["UPDATE attendance", { throwError: pgError("23503", "attendance_deleted_by_employee_id_fkey") }],
  ]);
  const repository = createAttendanceRepository(database);

  await assert.rejects(
    repository.deleteById("att-1", "ghost"),
    (error) => error.statusCode === 400 && error.code === "invalid_reference",
  );
});

// ---------------------------------------------------------------------------
// findById and the read SQL
// ---------------------------------------------------------------------------

test("findById: joins employees for department_id and does NOT filter on employees.deleted_at", async () => {
  // A manager must still be scope-checked, and an admin able to correct, a record whose
  // employee has since been soft-deleted -- the department survives the soft delete.
  const database = fakeDatabase([
    [/FROM attendance/, { rows: [{ ...ATTENDANCE_ROW, employee_department_id: "dept-1" }] }],
  ]);
  const repository = createAttendanceRepository(database);

  const result = await repository.findById("att-1");

  assert.equal(result.employee_department_id, "dept-1");
  const { text, values } = database.calls[0];
  assert.match(text, /employees\.department_id AS employee_department_id/);
  assert.match(text, /JOIN employees ON employees\.id = attendance\.employee_id/);
  assert.match(text, /attendance\.deleted_at IS NULL/);
  assert.doesNotMatch(text, /employees\.deleted_at/);
  assert.deepEqual(values, ["att-1"]);
});

test("findById: returns null when there is no live record", async () => {
  const database = fakeDatabase([[/FROM attendance/, { rows: [] }]]);
  const repository = createAttendanceRepository(database);

  assert.equal(await repository.findById("missing"), null);
});

test("reads format work_date and the times in SQL, so a UTC+5 server cannot serialise a day early", async () => {
  // pg parses a `date` column into a JS Date at server-local midnight; to_char sidesteps it.
  const database = fakeDatabase([[/FROM attendance/, { rows: [] }]]);
  const repository = createAttendanceRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal("att-1", principal);
  await repository.findById("att-1");

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    assert.match(text, /to_char\(attendance\.work_date, 'YYYY-MM-DD'\) AS work_date/);
    assert.match(text, /to_char\(attendance\.check_in, 'HH24:MI'\) AS check_in/);
    assert.match(text, /to_char\(attendance\.check_out, 'HH24:MI'\) AS check_out/);
  }
});

test("write re-selects use the same formatted column list as the reads", async () => {
  const database = fakeDatabase([
    ["INSERT INTO attendance", { rows: [{ id: "att-1" }] }],
    [SELECT_ATTENDANCE, { rows: [ATTENDANCE_ROW] }],
  ]);
  const repository = createAttendanceRepository(database);

  await repository.create({ employee_id: "emp-1", work_date: "2026-10-01", status: "present" });

  const select = textsOf(database).find((text) => text.startsWith("SELECT"));
  assert.match(select, /to_char\(attendance\.work_date, 'YYYY-MM-DD'\) AS work_date/);
});
