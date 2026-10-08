import assert from "node:assert/strict";
import test from "node:test";
import { createLeaveRepository } from "../src/repositories/leaveRepository.js";
import { HttpError } from "../src/utils/httpError.js";

// No database. Fake client matches queries by regex against a handler table, with whitespace
// collapsed so multi-line SQL can be matched on one line (same shape as projectRepository.test.js).
// Read-side scope coverage lives in resourceRepositories.test.js -- this file is the write path, plus
// the SQL shape its guarantees depend on. The real lock, the real constraint names, pg's actual date
// handling and the days-taken view are proved against a database by scripts/e2e-leaves.js.

function fakeDatabase(handlers) {
  const calls = [];
  async function run(via, text, values) {
    const normalized = text.trim().replace(/\s+/g, " ");
    calls.push({ via, text: normalized, values });
    for (const [matcher, response] of handlers) {
      const matches = typeof matcher === "string" ? normalized.includes(matcher) : matcher.test(normalized);
      if (!matches) continue;
      const resolved = typeof response === "function" ? response(values) : response;
      if (resolved?.throwError) throw resolved.throwError;
      return resolved ?? { rows: [] };
    }
    return { rows: [] };
  }
  const client = { query: (text, values) => run("client", text, values), release() { this.released = true; } };
  return { calls, client, query: (text, values) => run("pool", text, values), connect: async () => client };
}

const LEAVE = "leave-1";
const EMPLOYEE = "emp-1";
const DECIDER = "decider-emp";
const DELETER = "deleter-emp";

const indexOf = (database, matcher) => database.calls.findIndex((call) => matcher.test(call.text));
const callStarting = (database, prefix) => database.calls.find((call) => call.text.startsWith(prefix));
const pgError = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

const LOCK_EMPLOYEE = [/FROM employees WHERE id = \$1 AND deleted_at IS NULL FOR NO KEY UPDATE/, { rows: [{ id: EMPLOYEE }] }];
const INSERT = [/^INSERT INTO leaves/, { rows: [{ id: LEAVE }] }];
const SELECT_LEAVE = (rows = [{ id: LEAVE, status: "pending" }]) => [/FROM leaves WHERE leaves\.id = \$1 AND leaves\.deleted_at IS NULL/, { rows }];

const CREATE_INPUT = Object.freeze({
  employee_id: EMPLOYEE, type: "Annual", start_date: "2026-03-10", end_date: "2026-03-11", reason: "Family", applied_on: "2026-03-04",
});

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

// ---------------------------------------------------------------------------
// Serialization (D31)
// ---------------------------------------------------------------------------

test("every read selects start_date, end_date and applied_on as YYYY-MM-DD text, so a UTC+5 server cannot serialise a day early", async () => {
  const database = fakeDatabase([[/FROM leaves/, { rows: [] }]]);
  const repository = createLeaveRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal(LEAVE, principal);
  await repository.findByIdForWrite(LEAVE);

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    assert.match(text, /to_char\(leaves\.start_date, 'YYYY-MM-DD'\) AS start_date/);
    assert.match(text, /to_char\(leaves\.end_date, 'YYYY-MM-DD'\) AS end_date/);
    assert.match(text, /to_char\(leaves\.applied_on, 'YYYY-MM-DD'\) AS applied_on/);
  }
});

test("write re-selects use the same formatted column list as the reads", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);

  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const select = database.calls.find((call) => /FROM leaves WHERE leaves\.id/.test(call.text));
  assert.match(select.text, /to_char\(leaves\.start_date, 'YYYY-MM-DD'\) AS start_date/);
  assert.match(select.text, /leaves\.days/);
});

test("the read shape never exposes the deleter or the deleted_at of a live row", async () => {
  const database = fakeDatabase([[/FROM leaves/, { rows: [] }]]);
  await createLeaveRepository(database).findByIdForWrite(LEAVE);

  const select = database.calls[0].text;
  assert.doesNotMatch(select, /leaves\.deleted_by_employee_id/);
  assert.doesNotMatch(select, /leaves\.deleted_at,/);
});

// ---------------------------------------------------------------------------
// findByIdForWrite
// ---------------------------------------------------------------------------

test("findByIdForWrite: the live leave plus its employee's department and team lead, unscoped", async () => {
  const database = fakeDatabase([[/FROM leaves JOIN employees/, { rows: [{ id: LEAVE, employee_department_id: "d1", employee_team_lead_id: "tl" }] }]]);

  const result = await createLeaveRepository(database).findByIdForWrite(LEAVE);

  assert.equal(result.employee_department_id, "d1");
  assert.equal(result.employee_team_lead_id, "tl");
  const { text } = database.calls[0];
  assert.match(text, /employees\.department_id AS employee_department_id/);
  assert.match(text, /employees\.team_lead_id AS employee_team_lead_id/);
  assert.match(text, /leaves\.deleted_at IS NULL/);
});

test("findByIdForWrite: does not filter on employees.deleted_at, so a deleted employee's leave stays decidable and removable", async () => {
  const database = fakeDatabase([]);
  await createLeaveRepository(database).findByIdForWrite(LEAVE);

  assert.doesNotMatch(database.calls[0].text, /employees\.deleted_at/);
});

test("findByIdForWrite: a missing or deleted leave is null", async () => {
  assert.equal(await createLeaveRepository(fakeDatabase([])).findByIdForWrite(LEAVE), null);
});

// ---------------------------------------------------------------------------
// create: the per-employee lock, the order of the checks, the insert
// ---------------------------------------------------------------------------

test("create: BEGIN, then the employee row is locked FOR NO KEY UPDATE, then the overlap read, then validate, then INSERT, then COMMIT", async () => {
  const order = [];
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  const repository = createLeaveRepository(database);

  await repository.create(CREATE_INPUT, async () => {
    order.push("validate");
    // validate ran after the lock and the overlap read, and before the insert
    assert.ok(indexOf(database, /FOR NO KEY UPDATE/) < indexOf(database, /FROM leaves WHERE employee_id/));
    assert.equal(indexOf(database, /^INSERT INTO leaves/), -1, "no insert before validate returns");
  });

  assert.deepEqual(order, ["validate"]);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.ok(indexOf(database, /FOR NO KEY UPDATE/) < indexOf(database, /^INSERT INTO leaves/));
  assert.equal(database.calls.at(-1).text, "COMMIT");
  assert.ok(database.calls.every((call) => call.via === "client"), "everything on the one transaction client");
  assert.equal(database.client.released, true);
});

test("create: the lock is FOR NO KEY UPDATE, never FOR UPDATE -- other tables' foreign-key checks on the employee must not block", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const lock = database.calls.find((call) => /FROM employees/.test(call.text));
  assert.match(lock.text, /FOR NO KEY UPDATE$/);
  assert.doesNotMatch(lock.text, /FOR UPDATE/);
  assert.deepEqual(lock.values, [EMPLOYEE]);
});

test("create: the lock is taken on a LIVE employee, and reads nothing about them beyond the id (no joining date: D40)", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const lock = database.calls.find((call) => /FROM employees/.test(call.text));
  assert.equal(lock.text, "SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE");
  assert.doesNotMatch(lock.text, /joined_on/);
});

test("create: an unknown or deleted employee is 400 invalid_employee, rolled back, and nothing else is read", async () => {
  const database = fakeDatabase([[/FOR NO KEY UPDATE/, { rows: [] }]]);

  const error = await rejection(createLeaveRepository(database).create(CREATE_INPUT, async () => { throw new Error("validate must not run"); }));

  assert.equal(error?.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
  assert.equal(database.calls.some((call) => /^INSERT/.test(call.text)), false);
  assert.equal(database.calls.some((call) => /employee_leave_usage/.test(call.text)), false);
  assert.equal(database.client.released, true);
});

test("create: the overlap read considers only the employee's own live pending and approved leaves that intersect the dates", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const overlap = database.calls.find((call) => /FROM leaves WHERE employee_id/.test(call.text));
  assert.match(overlap.text, /deleted_at IS NULL/);
  assert.match(overlap.text, /status IN \('pending', 'approved'\)/);
  assert.match(overlap.text, /start_date <= \$3::date AND end_date >= \$2::date/, "closed-interval intersection");
  assert.doesNotMatch(overlap.text, /'rejected'/);
  assert.deepEqual(overlap.values, [EMPLOYEE, "2026-03-10", "2026-03-11"]);
});

test("create: back-to-back leaves do not overlap -- the intersection is inclusive on days, so the test is strict about shared days only", async () => {
  // start <= newEnd AND end >= newStart: a leave ending the day BEFORE the new start fails the second
  // condition (end < newStart), one starting the day AFTER the new end fails the first.
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const overlap = database.calls.find((call) => /FROM leaves WHERE employee_id/.test(call.text));
  assert.doesNotMatch(overlap.text, /start_date < |end_date > /);
});

test("create: D40 -- it reads NO usage and checks NO balance: the only reads are the lock and the overlap", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  const repository = createLeaveRepository(database);

  await repository.create(CREATE_INPUT, async () => {});
  // a request spanning a year boundary and a very long one, which the pool model used to read usage for
  await repository.create({ ...CREATE_INPUT, start_date: "2026-12-30", end_date: "2027-01-02" }, async () => {});
  await repository.create({ ...CREATE_INPUT, start_date: "2026-01-01", end_date: "2027-06-30" }, async () => {});

  assert.equal(database.calls.some((call) => /employee_leave_usage/.test(call.text)), false);
  const reads = database.calls.filter((call) => /^SELECT/.test(call.text) && !/FROM leaves WHERE leaves\.id/.test(call.text));
  assert.equal(reads.length, 6, "per create: the lock and the overlap read, and nothing else");
});

test("create: validate receives the overlapping leaves the read returned -- and nothing else", async () => {
  const database = fakeDatabase([
    LOCK_EMPLOYEE,
    [/FROM leaves WHERE employee_id/, { rows: [{ id: "other-leave" }] }],
    INSERT,
    SELECT_LEAVE(),
  ]);
  let received;

  await createLeaveRepository(database).create(CREATE_INPUT, async (context) => { received = context; });

  assert.deepEqual(received, { overlapping: [{ id: "other-leave" }] });
});

test("create: a refusal thrown by validate rolls back, inserts nothing, releases the client and surfaces unchanged", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  const refusal = new HttpError(409, "leave_overlaps", "overlap", { existing_id: "other-leave" });

  const error = await rejection(createLeaveRepository(database).create(CREATE_INPUT, async () => { throw refusal; }));

  assert.equal(error, refusal);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
  assert.equal(database.calls.some((call) => /^INSERT/.test(call.text)), false);
  assert.equal(database.calls.some((call) => call.text === "COMMIT"), false);
  assert.equal(database.client.released, true);
});

test("create: inserts only the application fields -- status, days and every decision/deleted column are left to defaults", async () => {
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE()]);
  await createLeaveRepository(database).create(CREATE_INPUT, async () => {});

  const insert = callStarting(database, "INSERT INTO leaves");
  assert.equal(insert.text, "INSERT INTO leaves (employee_id, type, start_date, end_date, reason, applied_on) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id");
  assert.deepEqual(insert.values, [EMPLOYEE, "Annual", "2026-03-10", "2026-03-11", "Family", "2026-03-04"]);
  assert.doesNotMatch(insert.text, /status|days|decided|deleted|decision_recorded/);
});

test("create: returns the re-selected, read-shaped row", async () => {
  const row = { id: LEAVE, status: "pending", start_date: "2026-03-10" };
  const database = fakeDatabase([LOCK_EMPLOYEE, INSERT, SELECT_LEAVE([row])]);

  assert.deepEqual(await createLeaveRepository(database).create(CREATE_INPUT, async () => {}), row);
});

test("create: translates constraint violations instead of leaking a 500 -- dates ordered, employee FK, other CHECKs", async () => {
  const cases = [
    [pgError("23514", "leaves_dates_ordered"), 400, "invalid_dates"],
    [pgError("23503", "leaves_employee_id_fkey"), 400, "invalid_employee"],
    [pgError("23514", "leaves_something_else"), 400, "invalid_request"],
    [pgError("23503", "leaves_other_fkey"), 400, "invalid_reference"],
  ];
  for (const [thrown, status, code] of cases) {
    const database = fakeDatabase([LOCK_EMPLOYEE, [/^INSERT INTO leaves/, { throwError: thrown }]]);
    const error = await rejection(createLeaveRepository(database).create(CREATE_INPUT, async () => {}));

    assert.equal(error?.statusCode, status, thrown.constraint);
    assert.equal(error.code, code, thrown.constraint);
    assert.equal(database.calls.at(-1).text, "ROLLBACK", thrown.constraint);
  }
});

test("create: an unrecognised database error is rethrown as-is, rolled back", async () => {
  const unexpected = new Error("connection reset");
  const database = fakeDatabase([LOCK_EMPLOYEE, [/^INSERT INTO leaves/, { throwError: unexpected }]]);

  assert.equal(await rejection(createLeaveRepository(database).create(CREATE_INPUT, async () => {})), unexpected);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

test("decide: a guarded UPDATE -- only a live PENDING leave -- writing status, decider and decided_at together, in one transaction", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }], SELECT_LEAVE([{ id: LEAVE, status: "approved" }])]);

  const result = await createLeaveRepository(database).decide(LEAVE, { status: "approved", decidedByEmployeeId: DECIDER });

  assert.equal(result.status, "approved");
  const update = callStarting(database, "UPDATE leaves");
  assert.match(update.text, /SET status = \$2, decided_by_employee_id = \$3, decided_at = now\(\)/);
  assert.match(update.text, /WHERE id = \$1 AND deleted_at IS NULL AND status = 'pending'/);
  assert.deepEqual(update.values, [LEAVE, "approved", DECIDER]);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("decide: never writes decision_recorded, so the column default (true) stands", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }], SELECT_LEAVE()]);
  await createLeaveRepository(database).decide(LEAVE, { status: "rejected", decidedByEmployeeId: DECIDER });

  assert.doesNotMatch(callStarting(database, "UPDATE leaves").text, /decision_recorded/);
});

test("decide: a leave that exists but is no longer pending is 409 leave_already_decided, rolled back once", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [] }], SELECT_LEAVE([{ id: LEAVE, status: "approved" }])]);

  const error = await rejection(createLeaveRepository(database).decide(LEAVE, { status: "rejected", decidedByEmployeeId: DECIDER }));

  assert.equal(error?.statusCode, 409);
  assert.equal(error.code, "leave_already_decided");
  assert.equal(database.calls.filter((call) => call.text === "ROLLBACK").length, 1, "no second rollback after the HttpError");
  assert.equal(database.calls.some((call) => call.text === "COMMIT"), false);
  assert.equal(database.client.released, true);
});

test("decide: a leave that does not exist (or is deleted) is null, not an error", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [] }], SELECT_LEAVE([])]);

  assert.equal(await createLeaveRepository(database).decide(LEAVE, { status: "approved", decidedByEmployeeId: DECIDER }), null);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("decide: D8 -- the self-approval ban is the DATABASE's: leaves_no_self_approval comes back as a clean 403, not re-implemented", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { throwError: pgError("23514", "leaves_no_self_approval") }]]);

  const error = await rejection(createLeaveRepository(database).decide(LEAVE, { status: "approved", decidedByEmployeeId: EMPLOYEE }));

  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "self_approval_denied");
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
  assert.equal(database.client.released, true);
});

test("decide: the repository itself does not compare decider to applicant -- the refusal comes only from the constraint", async () => {
  // Same ids on both sides and a succeeding UPDATE: if the repository checked, it would refuse here.
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }], SELECT_LEAVE()]);

  await createLeaveRepository(database).decide(LEAVE, { status: "approved", decidedByEmployeeId: EMPLOYEE });

  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("decide: a decider FK failure is 400 invalid_reference", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { throwError: pgError("23503", "leaves_decided_by_employee_id_fkey") }]]);

  const error = await rejection(createLeaveRepository(database).decide(LEAVE, { status: "approved", decidedByEmployeeId: "ghost" }));
  assert.equal(error?.code, "invalid_reference");
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: a soft delete that records who did it, never a DELETE", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }]]);

  await createLeaveRepository(database).deleteById(LEAVE, DELETER);

  const update = callStarting(database, "UPDATE leaves");
  assert.match(update.text, /SET deleted_at = now\(\), deleted_by_employee_id = \$2/);
  assert.deepEqual(update.values, [LEAVE, DELETER]);
  assert.equal(database.calls.some((call) => /^DELETE/.test(call.text)), false);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: admin/hr mode has NO status condition -- any status can be corrected", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }]]);
  await createLeaveRepository(database).deleteById(LEAVE, DELETER, { pendingOnly: false });

  const { text } = callStarting(database, "UPDATE leaves");
  assert.match(text, /WHERE id = \$1 AND deleted_at IS NULL RETURNING id/);
  assert.doesNotMatch(text, /status/);
});

test("deleteById: the employee's own cancel is guarded on status = 'pending', atomically", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [{ id: LEAVE }] }]]);
  await createLeaveRepository(database).deleteById(LEAVE, DELETER, { pendingOnly: true });

  assert.match(callStarting(database, "UPDATE leaves").text, /WHERE id = \$1 AND deleted_at IS NULL AND status = 'pending'/);
});

test("deleteById: a leave decided between the service's read and this write is 409, not cancelled", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [] }], SELECT_LEAVE([{ id: LEAVE, status: "approved" }])]);

  const error = await rejection(createLeaveRepository(database).deleteById(LEAVE, DELETER, { pendingOnly: true }));

  assert.equal(error?.statusCode, 409);
  assert.equal(error.code, "leave_already_decided");
  assert.equal(database.calls.filter((call) => call.text === "ROLLBACK").length, 1);
});

test("deleteById: a leave that does not exist (or is already deleted) is 404", async () => {
  for (const pendingOnly of [true, false]) {
    const database = fakeDatabase([[/^UPDATE leaves/, { rows: [] }], SELECT_LEAVE([])]);
    const error = await rejection(createLeaveRepository(database).deleteById(LEAVE, DELETER, { pendingOnly }));

    assert.equal(error?.statusCode, 404, `pendingOnly=${pendingOnly}`);
    assert.equal(error.code, "not_found");
    assert.equal(database.client.released, true);
  }
});

test("deleteById: admin/hr mode never re-selects to decide between 404 and 409 -- with no status guard, no row means no leave", async () => {
  const database = fakeDatabase([[/^UPDATE leaves/, { rows: [] }]]);
  await rejection(createLeaveRepository(database).deleteById(LEAVE, DELETER, { pendingOnly: false }));

  assert.equal(database.calls.some((call) => /^SELECT/.test(call.text)), false);
});

// ---------------------------------------------------------------------------
// daysTaken (D40)
// ---------------------------------------------------------------------------

test("daysTaken: one row per type from the restored view, for this employee and this calendar year", async () => {
  const taken = [{ type: "Annual", days_used: 5 }, { type: "Sick", days_used: 2 }];
  const database = fakeDatabase([
    [/FROM employees WHERE id = \$1 AND deleted_at IS NULL/, { rows: [{ id: EMPLOYEE }] }],
    [/FROM employee_leave_usage/, { rows: taken }],
  ]);

  const result = await createLeaveRepository(database).daysTaken(EMPLOYEE, 2026);

  assert.deepEqual(result, taken);
  assert.deepEqual(database.calls[1].values, [EMPLOYEE, 2026]);
  assert.match(database.calls[1].text, /WHERE employee_id = \$1 AND leave_year = \$2::int/);
});

test("daysTaken: reads the 001-shaped columns (leave_year, days_used) -- not the per-month ones migration 010 had", async () => {
  const database = fakeDatabase([[/FROM employees/, { rows: [{ id: EMPLOYEE }] }]]);
  await createLeaveRepository(database).daysTaken(EMPLOYEE, 2026);

  const { text } = database.calls[1];
  assert.match(text, /days_used/);
  assert.match(text, /leave_year/);
  assert.doesNotMatch(text, /usage_year|usage_month|days_approved|days_pending/);
});

test("daysTaken: days_used is cast to int in SQL, because sum(integer) is bigint and pg returns bigint as a string", async () => {
  const database = fakeDatabase([[/FROM employees/, { rows: [{ id: EMPLOYEE }] }]]);
  await createLeaveRepository(database).daysTaken(EMPLOYEE, 2026);

  assert.match(database.calls[1].text, /days_used::int AS days_used/);
  assert.match(database.calls[1].text, /type::text AS type/);
});

test("daysTaken: an employee with no approved leave that year is an empty list, not null", async () => {
  const database = fakeDatabase([[/FROM employees/, { rows: [{ id: EMPLOYEE }] }]]);

  assert.deepEqual(await createLeaveRepository(database).daysTaken(EMPLOYEE, 2026), []);
});

test("daysTaken: an unknown or deleted employee is null and the usage view is never queried", async () => {
  const database = fakeDatabase([]);

  assert.equal(await createLeaveRepository(database).daysTaken(EMPLOYEE, 2026), null);
  assert.equal(database.calls.length, 1);
});

// ---------------------------------------------------------------------------
// The concurrent-apply lock, modelled
// ---------------------------------------------------------------------------

test("create under a per-employee lock: concurrent applies for the SAME dates admit exactly one", async () => {
  // A unit test cannot prove Postgres serialises on FOR NO KEY UPDATE -- scripts/e2e-leaves.js does,
  // with real concurrent transactions. What it CAN prove is that the repository's ORDER is correct
  // for the lock to work: the lock is taken before the overlap read, and the overlap read is taken
  // before validate. This models the lock as a mutex held from the lock query until COMMIT/ROLLBACK
  // and shows that, given that order, the second apply sees the first's insert and is refused as an
  // overlap. (The lock was added for a balance check; since D40 the overlap check is what needs it.)
  const committed = [];                      // rows visible to later readers
  let held = Promise.resolve();
  let release;

  function lockingDatabase() {
    return {
      async connect() {
        let mine;
        const client = {
          async query(text) {
            const sql = text.trim().replace(/\s+/g, " ");
            if (/FOR NO KEY UPDATE/.test(sql)) {
              const previous = held;
              held = new Promise((resolve) => { release = resolve; });
              mine = release;
              await previous;                // blocks until the earlier holder commits or rolls back
              return { rows: [{ id: EMPLOYEE }] };
            }
            if (/FROM leaves WHERE employee_id/.test(sql)) {
              // the overlap read: sees whatever an earlier holder has COMMITTED by now
              return { rows: committed.length ? [{ id: "leave-1" }] : [] };
            }
            if (/^INSERT INTO leaves/.test(sql)) {
              await new Promise((resolve) => setImmediate(resolve));   // give the other request every chance to interleave
              committed.push("row");
              return { rows: [{ id: `leave-${committed.length}` }] };
            }
            if (/FROM leaves WHERE leaves\.id/.test(sql)) return { rows: [{ id: "leave-x", status: "pending" }] };
            if (sql === "COMMIT" || sql === "ROLLBACK") mine?.();
            return { rows: [] };
          },
          release() {},
        };
        return client;
      },
    };
  }

  const repository = createLeaveRepository(lockingDatabase());
  const oneDay = { ...CREATE_INPUT, start_date: "2026-03-10", end_date: "2026-03-10" };
  const validate = async ({ overlapping }) => {
    if (overlapping.length > 0) throw new HttpError(409, "leave_overlaps", "overlap");
  };

  const results = await Promise.allSettled([
    repository.create(oneDay, validate), repository.create(oneDay, validate), repository.create(oneDay, validate),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "exactly one apply wins");
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "leave_overlaps").length, 2);
  assert.equal(committed.length, 1);
});
