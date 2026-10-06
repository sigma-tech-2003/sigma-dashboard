import assert from "node:assert/strict";
import test from "node:test";
import { createKpiRepository } from "../src/repositories/kpiRepository.js";

// No database. Fake client matches queries by regex against a handler table, same shape as
// projectRepository.test.js's fakeDatabase, with whitespace collapsed. Read-side scope coverage
// lives in resourceRepositories.test.js -- this file is the write path, the rating's constraint
// translation (D29: the bans are database constraints, surfaced here as clean errors, never
// re-implemented), and the SQL shape the guarantees depend on. The real locks, the real constraint
// names and the real refusals are proved against a database by scripts/e2e-projects-kpis.js.

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
  const client = { query: (text, values) => run("client", text, values), release() {} };
  return { calls, query: (text, values) => run("pool", text, values), connect: async () => client };
}

const KPI = "kpi-1";
const PROJECT = "prj-1";
const EMPLOYEE = "emp-1";
const RATER = "rater-emp";
const DELETER = "deleter-emp";

const indexOf = (database, matcher) => database.calls.findIndex((call) => matcher.test(call.text));
const countOf = (database, text) => database.calls.filter((call) => call.text === text).length;
const callStarting = (database, prefix) => database.calls.find((call) => call.text.startsWith(prefix));
const pgError = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

const KPI_ROW = Object.freeze({
  id: KPI, project_id: PROJECT, employee_id: EMPLOYEE, title: "Ship it", target: 100, current_value: 0,
  weight: 50, period: "Q1", status: "active", rating: null, rated_by_employee_id: null, rated_at: null,
});
const SELECT_KPI = [/SELECT .* FROM kpis WHERE kpis\.id = \$1/, { rows: [KPI_ROW] }];
const LOCK_PROJECT = [/SELECT id FROM projects WHERE id = \$1 AND deleted_at IS NULL FOR SHARE/, { rows: [{ id: PROJECT }] }];
const LOCK_ASSIGNMENT = [/FROM project_assignments WHERE project_id = \$1 AND employee_id = \$2 FOR SHARE/, { rows: [{ assigned: 1 }] }];

const CREATE_INPUT = Object.freeze({
  project_id: PROJECT, employee_id: EMPLOYEE, title: "Ship it", target: 100, current_value: 0,
  weight: 50, period: "Q1", status: "active",
});

// ---------------------------------------------------------------------------
// Serialization (D29)
// ---------------------------------------------------------------------------

test("every read selects target and current_value as float8, so responses carry numbers, not strings", async () => {
  // pg returns numeric as a string ("1000.00"); the frontend does arithmetic on these and would
  // concatenate them. float8 makes pg hand back a JS number.
  const database = fakeDatabase([[/FROM kpis/, { rows: [] }]]);
  const repository = createKpiRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal(KPI, principal);
  await repository.findByIdForWrite(KPI);

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    assert.match(text, /kpis\.target::float8 AS target/);
    assert.match(text, /kpis\.current_value::float8 AS current_value/);
  }
});

test("write re-selects use the same float8 column list as the reads", async () => {
  const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).create(CREATE_INPUT);

  const select = database.calls.find((call) => /FROM kpis WHERE kpis\.id/.test(call.text));
  assert.match(select.text, /kpis\.target::float8 AS target/);
  assert.match(select.text, /kpis\.current_value::float8 AS current_value/);
});

test("the cast is for the amounts only -- weight, rating and ids are left alone", async () => {
  const database = fakeDatabase([[/FROM kpis/, { rows: [] }]]);
  await createKpiRepository(database).findByIdForWrite(KPI);

  assert.doesNotMatch(database.calls[0].text, /weight::float8|rating::float8|id::float8/);
});

// ---------------------------------------------------------------------------
// findByIdForWrite
// ---------------------------------------------------------------------------

test("findByIdForWrite: the live KPI with its employee's and project's context, assignee team leads as an array", async () => {
  const database = fakeDatabase([[/FROM kpis/, { rows: [{ ...KPI_ROW, employee_department_id: "d1", project_assignee_team_lead_ids: ["tl-a"] }] }]]);

  const result = await createKpiRepository(database).findByIdForWrite(KPI);

  assert.equal(result.employee_department_id, "d1");
  assert.deepEqual(result.project_assignee_team_lead_ids, ["tl-a"]);
  const { text, values } = database.calls[0];
  assert.match(text, /employees\.department_id AS employee_department_id/);
  assert.match(text, /employees\.team_lead_id AS employee_team_lead_id/);
  assert.match(text, /projects\.department_id AS project_department_id/);
  assert.match(text, /projects\.team_lead_id AS project_team_lead_id/);
  assert.match(text, /ARRAY\( SELECT assignee\.team_lead_id FROM project_assignments JOIN employees AS assignee/);
  assert.match(text, /kpis\.id = \$1 AND kpis\.deleted_at IS NULL/);
  assert.deepEqual(values, [KPI]);
});

test("findByIdForWrite: the project is LEFT-joined and NOT filtered on its own deleted_at, so a legacy or orphaned KPI still authorizes", async () => {
  const database = fakeDatabase([[/FROM kpis/, { rows: [] }]]);

  await createKpiRepository(database).findByIdForWrite(KPI);

  const { text } = database.calls[0];
  assert.match(text, /LEFT JOIN projects ON projects\.id = kpis\.project_id/);
  assert.doesNotMatch(text, /projects\.deleted_at/);
  assert.match(text, /JOIN employees ON employees\.id = kpis\.employee_id/);
});

test("findByIdForWrite: a missing or deleted KPI is null", async () => {
  const database = fakeDatabase([[/FROM kpis/, { rows: [] }]]);

  assert.equal(await createKpiRepository(database).findByIdForWrite(KPI), null);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: happy path locks, inserts, re-selects and commits", async () => {
  const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  const result = await createKpiRepository(database).create(CREATE_INPUT);

  assert.deepEqual(result, KPI_ROW);
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
  assert.deepEqual(
    callStarting(database, "INSERT INTO kpis").values,
    [PROJECT, EMPLOYEE, "Ship it", 100, 0, 50, "Q1", "active"],
  );
});

test("create: the project is locked FOR SHARE, then the employee's assignment FOR SHARE, then the INSERT -- in that order", async () => {
  // These locks serialise create against a concurrent project edit or delete, which takes FOR
  // UPDATE on the same rows before it counts KPIs: it either waits for this KPI to commit and then
  // counts it, or commits first and this create finds the assignment or project gone.
  const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).create(CREATE_INPUT);

  const project = indexOf(database, /FROM projects WHERE id = \$1 AND deleted_at IS NULL FOR SHARE/);
  const assignment = indexOf(database, /FROM project_assignments WHERE project_id = \$1 AND employee_id = \$2 FOR SHARE/);
  const insert = indexOf(database, /^INSERT INTO kpis/);
  assert.ok(project >= 0 && assignment > project && insert > assignment, "project lock < assignment lock < insert");
  assert.deepEqual(database.calls[assignment].values, [PROJECT, EMPLOYEE]);
});

test("create: the INSERT names no rating, deleted_* or timestamp column -- a new KPI is unrated", async () => {
  const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).create({
    ...CREATE_INPUT, rating: 9, rated_by_employee_id: "x", rated_at: "2000-01-01", created_at: "2000-01-01",
    updated_at: "2000-01-01", deleted_at: "2000-01-01", deleted_by_employee_id: "x",
  });

  const insert = callStarting(database, "INSERT INTO kpis");
  assert.doesNotMatch(insert.text.slice(0, insert.text.indexOf("VALUES")), /rating|rated|deleted|created_at|updated_at/);
  assert.equal(insert.values.length, 8);
});

test("create: a missing or deleted project is a clean 400 invalid_project, and nothing is inserted", async () => {
  const database = fakeDatabase([[/SELECT id FROM projects .* FOR SHARE/, { rows: [] }]]);

  await assert.rejects(createKpiRepository(database).create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "invalid_project");
    return true;
  });
  assert.equal(database.calls.some((call) => call.text.startsWith("INSERT")), false);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: an employee who is not an assignee is a clean 400 employee_not_assigned, and nothing is inserted", async () => {
  const database = fakeDatabase([LOCK_PROJECT, [/FROM project_assignments .* FOR SHARE/, { rows: [] }]]);

  await assert.rejects(createKpiRepository(database).create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "employee_not_assigned");
    return true;
  });
  assert.equal(database.calls.some((call) => call.text.startsWith("INSERT")), false);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: an unrecognised error is rethrown unchanged", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { throwError: boom }]]);

  await assert.rejects(createKpiRepository(database).create(CREATE_INPUT), (error) => error === boom);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// updateById
// ---------------------------------------------------------------------------

test("updateById: only the progress columns it was given are touched", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).updateById(KPI, { current_value: 5, title: "t" });

  const update = callStarting(database, "UPDATE kpis SET");
  assert.match(update.text, /title = \$1, current_value = \$2 WHERE id = \$3 AND deleted_at IS NULL RETURNING id/);
  assert.deepEqual(update.values, ["t", 5, KPI]);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("updateById: D29 -- employee_id and project_id are frozen: smuggled into the changes they never reach the SQL", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).updateById(KPI, { title: "t", employee_id: "other-emp", project_id: "other-prj" });

  const update = callStarting(database, "UPDATE kpis SET");
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  assert.doesNotMatch(setClause, /employee_id|project_id/);
  assert.deepEqual(update.values, ["t", KPI]);
});

test("updateById: the rating columns, deleted_* and timestamps are never writable here either", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).updateById(KPI, {
    weight: 10, rating: 9, rated_by_employee_id: "x", rated_at: "2000-01-01", deleted_at: "2000-01-01",
    deleted_by_employee_id: "x", created_at: "2000-01-01", updated_at: "2000-01-01",
  });

  const update = callStarting(database, "UPDATE kpis SET");
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  assert.doesNotMatch(setClause, /rating|rated|deleted|created_at|updated_at/);
  assert.deepEqual(update.values, [10, KPI]);
});

test("updateById: a null-safe empty changes object skips the transaction entirely", async () => {
  const database = fakeDatabase([SELECT_KPI]);

  const result = await createKpiRepository(database).updateById(KPI, {});

  assert.deepEqual(result, KPI_ROW);
  assert.equal(database.calls.some((call) => call.text === "BEGIN"), false);
});

test("updateById: a missing or deleted KPI is null, and the transaction is rolled back", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET/, { rows: [] }]]);

  assert.equal(await createKpiRepository(database).updateById(KPI, { title: "x" }), null);
  assert.equal(countOf(database, "ROLLBACK"), 1);
  assert.equal(countOf(database, "COMMIT"), 0);
});

test("updateById: a CHECK violation translates and rolls back", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET/, { throwError: pgError("23514", "kpis_target_positive") }]]);

  await assert.rejects(
    createKpiRepository(database).updateById(KPI, { target: 0 }),
    (error) => error.statusCode === 400 && error.code === "invalid_target",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// rate
// ---------------------------------------------------------------------------

test("rate: sets the rating, the rater and the time TOGETHER, the time from now() -- never from the caller", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: RATER });

  const update = callStarting(database, "UPDATE kpis SET rating");
  assert.match(update.text, /SET rating = \$2, rated_by_employee_id = \$3, rated_at = now\(\)/);
  assert.match(update.text, /WHERE id = \$1 AND deleted_at IS NULL RETURNING id/);
  assert.deepEqual(update.values, [KPI, 8, RATER]);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("rate: writes nothing but the three rating columns", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: RATER });

  const update = callStarting(database, "UPDATE kpis SET rating");
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  // (?<![a-z_]) so the KPI's own employee_id column is not confused with rated_by_employee_id.
  assert.doesNotMatch(setClause, /title|target|current_value|weight|period|status|(?<![a-z_])employee_id|project_id|deleted/);
  assert.equal(setClause, "UPDATE kpis SET rating = $2, rated_by_employee_id = $3, rated_at = now()");
});

test("rate: the repository adds NO check of its own -- it is a single guarded UPDATE, so the constraints are what refuse", async () => {
  // No lookup of the KPI, its project or its employee: nothing here could pre-empt the database.
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { rows: [{ id: KPI }] }], SELECT_KPI]);

  await createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: RATER });

  const reads = database.calls.filter((call) => call.text.startsWith("SELECT")).map((call) => call.text);
  assert.equal(reads.length, 1, "only the final re-select");
  assert.match(reads[0], /FROM kpis WHERE kpis\.id = \$1/);
});

test("rate: D29 -- kpis_no_self_rating surfaces as 403 self_rating_denied", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { throwError: pgError("23514", "kpis_no_self_rating") }]]);

  await assert.rejects(createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: EMPLOYEE }), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "self_rating_denied");
    assert.match(error.message, /your own KPI/);
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("rate: D29 -- kpis_legacy_not_rateable surfaces as 409 legacy_kpi_not_rateable", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { throwError: pgError("23514", "kpis_legacy_not_rateable") }]]);

  await assert.rejects(createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: RATER }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "legacy_kpi_not_rateable");
    assert.match(error.message, /no project/);
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("rate: kpis_rating_range surfaces as 400 invalid_rating", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { throwError: pgError("23514", "kpis_rating_range") }]]);

  await assert.rejects(
    createKpiRepository(database).rate(KPI, { rating: 11, ratedByEmployeeId: RATER }),
    (error) => error.statusCode === 400 && error.code === "invalid_rating",
  );
});

test("rate: an unknown rater is a clean 400 invalid_reference rather than a 500", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { throwError: pgError("23503", "kpis_rated_by_employee_id_fkey") }]]);

  await assert.rejects(
    createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: "ghost" }),
    (error) => error.statusCode === 400 && error.code === "invalid_reference",
  );
});

test("rate: a missing or deleted KPI is null, and the transaction is rolled back", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET rating/, { rows: [] }]]);

  assert.equal(await createKpiRepository(database).rate(KPI, { rating: 8, ratedByEmployeeId: RATER }), null);
  assert.equal(countOf(database, "ROLLBACK"), 1);
  assert.equal(countOf(database, "COMMIT"), 0);
});

// ---------------------------------------------------------------------------
// Constraint translation
// ---------------------------------------------------------------------------

test("every other constraint and error code translates to a clean 4xx", async () => {
  const cases = [
    ["23514", "kpis_target_positive", 400, "invalid_target"],
    ["23514", "kpis_current_non_negative", 400, "invalid_current_value"],
    ["23514", "kpis_weight_range", 400, "invalid_weight"],
    ["23514", "kpis_title_not_blank", 400, "invalid_request"],
    ["23514", "kpis_rating_fields_consistent", 400, "invalid_request"],
    ["23503", "kpis_employee_id_fkey", 400, "invalid_employee"],
    ["23503", "kpis_project_id_fkey", 400, "invalid_project"],
    ["23503", "kpis_deleted_by_employee_id_fkey", 400, "invalid_reference"],
    ["22003", undefined, 400, "invalid_amounts"],
  ];
  for (const [code, constraint, status, expected] of cases) {
    const database = fakeDatabase([LOCK_PROJECT, LOCK_ASSIGNMENT, [/^INSERT INTO kpis/, { throwError: pgError(code, constraint) }]]);

    await assert.rejects(
      createKpiRepository(database).create(CREATE_INPUT),
      (error) => error.statusCode === status && error.code === expected,
      `${code} ${constraint}`,
    );
    assert.equal(database.calls.at(-1).text, "ROLLBACK", `${code} ${constraint}`);
  }
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: D29 -- soft deletes, setting deleted_at and recording the deleter; never a hard DELETE", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET deleted_at/, { rows: [{ id: KPI }] }]]);

  await createKpiRepository(database).deleteById(KPI, DELETER);

  const update = callStarting(database, "UPDATE kpis");
  assert.match(update.text, /deleted_at = now\(\)/);
  assert.match(update.text, /deleted_by_employee_id = \$2/);
  assert.match(update.text, /WHERE id = \$1 AND deleted_at IS NULL/);
  assert.deepEqual(update.values, [KPI, DELETER]);
  assert.equal(database.calls.some((call) => /^DELETE\b/i.test(call.text)), false, "never a hard DELETE");
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: a missing or already-deleted KPI is a clean 404, and rolls back", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET deleted_at/, { rows: [] }]]);

  await assert.rejects(createKpiRepository(database).deleteById(KPI, DELETER), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([[/^UPDATE kpis SET deleted_at/, { throwError: boom }]]);

  await assert.rejects(createKpiRepository(database).deleteById(KPI, DELETER), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: an unknown deleter id is a 400 invalid_reference rather than a 500", async () => {
  const database = fakeDatabase([[/^UPDATE kpis SET deleted_at/, { throwError: pgError("23503", "kpis_deleted_by_employee_id_fkey") }]]);

  await assert.rejects(
    createKpiRepository(database).deleteById(KPI, "ghost"),
    (error) => error.statusCode === 400 && error.code === "invalid_reference",
  );
});
