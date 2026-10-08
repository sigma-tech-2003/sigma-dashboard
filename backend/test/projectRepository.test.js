import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRepository } from "../src/repositories/projectRepository.js";

// No database. Fake client matches queries by regex against a handler table, same shape as
// payrollRepository.test.js's fakeDatabase, with whitespace collapsed so a multi-line SQL string
// can be matched on one line. Read-side scope coverage lives in resourceRepositories.test.js --
// this file is the write path, plus the SQL shape its guarantees depend on. The real locks, the
// real constraint names and pg's actual date handling are proved against a database by
// scripts/e2e-projects-kpis.js.

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

const D1 = "dept-1";
const D2 = "dept-2";
const PROJECT = "prj-1";
const DELETER = "deleter-emp";

const indexOf = (database, matcher) => database.calls.findIndex((call) => matcher.test(call.text));
const countOf = (database, text) => database.calls.filter((call) => call.text === text).length;
const callStarting = (database, prefix) => database.calls.find((call) => call.text.startsWith(prefix));
const pgError = (code, constraint) => Object.assign(new Error(`pg ${code}`), { code, constraint });

// Handlers shared by the update tests.
const LOCK_PROJECT = [/SELECT department_id FROM projects .* FOR UPDATE/, { rows: [{ department_id: D1 }] }];
const projectSelect = (rows = [{ id: PROJECT, department_id: D1 }]) => [/SELECT .* FROM projects WHERE projects\.id = \$1/, { rows }];
const currentAssignees = (...ids) => [
  /^SELECT employee_id FROM project_assignments WHERE project_id = \$1$/,
  { rows: ids.map((employee_id) => ({ employee_id })) },
];
const LOCK_REMOVED = [/FROM project_assignments WHERE project_id = \$1 AND employee_id = ANY\(\$2::uuid\[\]\) FOR UPDATE/, { rows: [] }];
const liveKpiCount = (count) => [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count }] }];

const CREATE_INPUT = Object.freeze({
  department_id: D1, team_lead_id: null, title: "Launch", description: "", start_date: "2026-01-01",
  due_date: "2026-02-01", status: "active", assigned_employee_ids: ["e1", "e2"],
});

// ---------------------------------------------------------------------------
// Serialization (D29)
// ---------------------------------------------------------------------------

test("every read selects start_date and due_date as YYYY-MM-DD text, so a UTC+5 server cannot serialise a day early", async () => {
  // pg parses a `date` column into a JS Date at server-local midnight; to_char sidesteps it.
  const database = fakeDatabase([[/FROM projects/, { rows: [] }]]);
  const repository = createProjectRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal(PROJECT, principal);
  await repository.findByIdForWrite(PROJECT);

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    assert.match(text, /to_char\(projects\.start_date, 'YYYY-MM-DD'\) AS start_date/);
    assert.match(text, /to_char\(projects\.due_date, 'YYYY-MM-DD'\) AS due_date/);
  }
});

test("write re-selects use the same formatted column list as the reads", async () => {
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
  ]);

  await createProjectRepository(database).create(CREATE_INPUT);

  const select = database.calls.find((call) => /FROM projects WHERE projects\.id/.test(call.text));
  assert.match(select.text, /to_char\(projects\.start_date, 'YYYY-MM-DD'\) AS start_date/);
  assert.match(select.text, /to_char\(projects\.due_date, 'YYYY-MM-DD'\) AS due_date/);
});

test("D33 -- every project read selects department_name beside department_id, as a subquery that adds no join", async () => {
  // Only admin and hr may read the departments list, but a manager, tl or employee needs the NAME of the
  // department their projects belong to.
  const database = fakeDatabase([[/FROM projects/, { rows: [] }]]);
  const repository = createProjectRepository(database);
  const principal = { userId: "u", employeeId: "e", role: "admin", departmentId: null };

  await repository.listForPrincipal(principal);
  await repository.findByIdForPrincipal(PROJECT, principal);
  await repository.findByIdForWrite(PROJECT);

  assert.equal(database.calls.length, 3);
  for (const { text } of database.calls) {
    assert.match(text, /\(SELECT departments\.name FROM departments WHERE departments\.id = projects\.department_id\) AS department_name/);
    assert.match(text, /projects\.department_id,/, "the id is still returned beside the name");
    assert.doesNotMatch(text, /JOIN departments/i);
    assert.match(text, / FROM projects WHERE projects\./, "FROM and WHERE are exactly as before");
  }
});

test("D33 -- the write re-select carries department_name too, so a write response has the read shape", async () => {
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
  ]);

  await createProjectRepository(database).create(CREATE_INPUT);

  const select = database.calls.find((call) => /FROM projects WHERE projects\.id/.test(call.text));
  assert.match(select.text, /AS department_name/);
});

test("a write result keeps the read shape: assignedEmployeeIds, not assigned_employee_ids (the deferred D29 inconsistency)", async () => {
  // Requests say assigned_employee_ids; every response -- read or write -- says assignedEmployeeIds,
  // the Phase 3 shape the parity harness depends on. Pinned so changing it later is deliberate.
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
    [/FROM project_assignments WHERE project_id = ANY/, { rows: [{ project_id: PROJECT, employee_id: "e1" }, { project_id: PROJECT, employee_id: "e2" }] }],
  ]);

  const result = await createProjectRepository(database).create(CREATE_INPUT);

  assert.deepEqual(result.assignedEmployeeIds, ["e1", "e2"]);
  assert.equal(Object.hasOwn(result, "assigned_employee_ids"), false);
});

// ---------------------------------------------------------------------------
// findByIdForWrite
// ---------------------------------------------------------------------------

test("findByIdForWrite: the live project plus each assignee's own team_lead_id, unscoped", async () => {
  const database = fakeDatabase([
    [/FROM projects WHERE projects\.id = \$1 AND projects\.deleted_at IS NULL/, { rows: [{ id: PROJECT, department_id: D1 }] }],
    [/FROM project_assignments JOIN employees/, { rows: [{ id: "e1", team_lead_id: "tl-a" }, { id: "e2", team_lead_id: null }] }],
  ]);

  const result = await createProjectRepository(database).findByIdForWrite(PROJECT);

  assert.deepEqual(result.assignees, [{ id: "e1", team_lead_id: "tl-a" }, { id: "e2", team_lead_id: null }]);
  assert.equal(result.department_id, D1);
  const assigneeQuery = database.calls.find((call) => /project_assignments/.test(call.text));
  assert.match(assigneeQuery.text, /JOIN employees ON employees\.id = project_assignments\.employee_id/);
  assert.match(assigneeQuery.text, /employees\.team_lead_id/);
});

test("findByIdForWrite: a missing or deleted project is null, and the assignee query is never run", async () => {
  const database = fakeDatabase([[/FROM projects/, { rows: [] }]]);

  assert.equal(await createProjectRepository(database).findByIdForWrite(PROJECT), null);
  assert.equal(database.calls.some((call) => /project_assignments/.test(call.text)), false);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: the company comes from the live department row, and the transaction commits", async () => {
  const database = fakeDatabase([
    [/SELECT company_id FROM departments WHERE id = \$1 AND deleted_at IS NULL/, { rows: [{ company_id: "co-1" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
  ]);

  await createProjectRepository(database).create(CREATE_INPUT);

  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
  const insert = callStarting(database, "INSERT INTO projects");
  assert.equal(insert.values[0], "co-1");
  assert.deepEqual(insert.values, ["co-1", D1, null, "Launch", "", "2026-01-01", "2026-02-01", "active"]);
});

test("create: the INSERT names no timestamp or deleted_* column", async () => {
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
  ]);

  await createProjectRepository(database).create({
    ...CREATE_INPUT, created_at: "2000-01-01", updated_at: "2000-01-01", deleted_at: "2000-01-01", deleted_by_employee_id: "x",
  });

  const insert = callStarting(database, "INSERT INTO projects");
  assert.doesNotMatch(insert.text.slice(0, insert.text.indexOf("VALUES")), /created_at|updated_at|deleted/);
  assert.equal(insert.values.includes("2000-01-01"), false);
});

test("create: every assignment goes in one statement, under the project's department", async () => {
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { rows: [{ id: PROJECT }] }],
    projectSelect(),
  ]);

  await createProjectRepository(database).create(CREATE_INPUT);

  const assignments = database.calls.filter((call) => call.text.startsWith("INSERT INTO project_assignments"));
  assert.equal(assignments.length, 1);
  assert.match(assignments[0].text, /unnest\(\$2::uuid\[\]\)/);
  // [projectId, employeeIds, departmentId]: the department is what the composite FKs check.
  assert.deepEqual(assignments[0].values, [PROJECT, ["e1", "e2"], D1]);
  assert.ok(indexOf(database, /^INSERT INTO projects/) < indexOf(database, /^INSERT INTO project_assignments/));
});

test("create: an unknown or deleted department is a clean 400 invalid_department, and nothing is inserted", async () => {
  const database = fakeDatabase([[/SELECT company_id FROM departments/, { rows: [] }]]);

  await assert.rejects(createProjectRepository(database).create(CREATE_INPUT), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "invalid_department");
    return true;
  });
  assert.equal(database.calls.some((call) => call.text.startsWith("INSERT")), false);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("create: constraint violations translate to clean 4xx errors, and the transaction is rolled back", async () => {
  const cases = [
    ["23503", "projects_team_lead_department_foreign_key", 400, "invalid_team_lead"],
    ["23503", "projects_department_company_foreign_key", 400, "invalid_department"],
    ["23503", "project_assignments_employee_department_foreign_key", 400, "invalid_assignee"],
    ["23503", "something_else_fkey", 400, "invalid_reference"],
    ["23514", "projects_dates_ordered", 400, "invalid_dates"],
    ["23514", "projects_title_not_blank", 400, "invalid_request"],
    ["23505", "project_assignments_pkey", 400, "invalid_assignee"],
    ["23505", "projects_pkey", 409, "conflict"],
  ];
  for (const [code, constraint, status, expected] of cases) {
    const database = fakeDatabase([
      [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
      [/^INSERT INTO projects/, { throwError: pgError(code, constraint) }],
    ]);

    await assert.rejects(
      createProjectRepository(database).create(CREATE_INPUT),
      (error) => error.statusCode === status && error.code === expected,
      `${code} ${constraint}`,
    );
    assert.equal(database.calls.at(-1).text, "ROLLBACK", constraint);
  }
});

test("create: an unrecognised error is rethrown unchanged", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    [/SELECT company_id FROM departments/, { rows: [{ company_id: "co" }] }],
    [/^INSERT INTO projects/, { throwError: boom }],
  ]);

  await assert.rejects(createProjectRepository(database).create(CREATE_INPUT), (error) => error === boom);
});

// ---------------------------------------------------------------------------
// updateById: the assignee replace-set
// ---------------------------------------------------------------------------

test("updateById: assignees are replaced by DIFFERENCE -- only removed rows deleted, only added rows inserted, an unchanged one untouched", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(0), projectSelect(),
  ]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1", "e3"] });

  const removal = callStarting(database, "DELETE FROM project_assignments");
  const addition = callStarting(database, "INSERT INTO project_assignments");
  assert.deepEqual(removal.values, [PROJECT, ["e2"]], "only e2 is removed");
  assert.deepEqual(addition.values, [PROJECT, ["e3"], D1], "only e3 is added, under the unchanged department");
  assert.ok(!removal.values[1].includes("e1") && !addition.values[1].includes("e1"), "e1 keeps its row and its assigned_at");
});

test("updateById: the whole replace is one transaction, removal before insertion", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(0), projectSelect(),
  ]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1", "e3"], title: "t" });

  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");
  assert.equal(countOf(database, "BEGIN"), 1);
  assert.ok(indexOf(database, /^DELETE FROM project_assignments/) < indexOf(database, /^INSERT INTO project_assignments/));
});

test("updateById: replacing the set with the SAME set does no delete and no insert", async () => {
  const database = fakeDatabase([LOCK_PROJECT, currentAssignees("e1", "e2"), projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e2", "e1"] });

  assert.equal(database.calls.some((call) => /^DELETE|^INSERT/.test(call.text)), false);
  assert.equal(database.calls.some((call) => /FROM kpis/.test(call.text)), false, "nothing removed, so no KPI check");
});

test("updateById: adding assignees never triggers the live-KPI check", async () => {
  const database = fakeDatabase([LOCK_PROJECT, currentAssignees("e1"), projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1", "e2", "e3"] });

  assert.equal(database.calls.some((call) => /FROM kpis/.test(call.text)), false);
  assert.deepEqual(callStarting(database, "INSERT INTO project_assignments").values[1], ["e2", "e3"]);
});

test("updateById: D29 -- removing an assignee who has live KPIs is a 409 assignee_has_kpis carrying the count", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(3), projectSelect(),
  ]);

  await assert.rejects(
    createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1"] }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "assignee_has_kpis");
      assert.deepEqual(error.details, { live_kpi_count: 3 });
      assert.match(error.message, /\b3\b/);
      return true;
    },
  );
  assert.equal(database.calls.some((call) => /^DELETE/.test(call.text)), false, "nothing is deleted");
  assert.equal(countOf(database, "COMMIT"), 0);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("updateById: the removed assignment rows are LOCKED before the KPIs are COUNTED (lock-then-count)", async () => {
  // A concurrent KPI create holds FOR SHARE on the assignment row, so this order means it is either
  // counted or waits and then finds the assignment gone -- never a KPI stranded on a removed assignee.
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(0), projectSelect(),
  ]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1"] });

  const lock = indexOf(database, /project_assignments WHERE project_id = \$1 AND employee_id = ANY\(\$2::uuid\[\]\) FOR UPDATE/);
  const count = indexOf(database, /SELECT count\(\*\)::int AS count FROM kpis/);
  const remove = indexOf(database, /^DELETE FROM project_assignments/);
  assert.ok(lock >= 0 && count > lock && remove > count, "lock < count < delete");
});

test("updateById: only the REMOVED employees are counted, and only live KPIs on this project", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(0), projectSelect(),
  ]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1"] });

  const count = callStarting(database, "SELECT count(*)::int AS count FROM kpis");
  assert.deepEqual(count.values, [PROJECT, ["e2"]]);
  assert.match(count.text, /project_id = \$1 AND employee_id = ANY\(\$2::uuid\[\]\) AND deleted_at IS NULL/);
});

// ---------------------------------------------------------------------------
// updateById: department change, scalars, and edge cases
// ---------------------------------------------------------------------------

test("updateById: a department change removes every old assignee, updates the project, then inserts the new set under the NEW department", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1", "e2"), LOCK_REMOVED, liveKpiCount(0), projectSelect(),
  ]);

  await createProjectRepository(database).updateById(PROJECT, {
    department_id: D2, team_lead_id: null, assigned_employee_ids: ["x1"],
  });

  const remove = indexOf(database, /^DELETE FROM project_assignments/);
  const update = indexOf(database, /^UPDATE projects SET/);
  const insert = indexOf(database, /^INSERT INTO project_assignments/);
  assert.ok(remove < update && update < insert, "DELETE < UPDATE < INSERT -- the composite foreign keys forbid any other order");
  assert.deepEqual(database.calls[remove].values, [PROJECT, ["e1", "e2"]], "every current assignee leaves");
  assert.deepEqual(database.calls[insert].values, [PROJECT, ["x1"], D2], "the new set is inserted under the new department");
});

test("updateById: a department change is still blocked while a departing assignee has live KPIs", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT, currentAssignees("e1"), LOCK_REMOVED, liveKpiCount(1), projectSelect(),
  ]);

  await assert.rejects(
    createProjectRepository(database).updateById(PROJECT, { department_id: D2, team_lead_id: null, assigned_employee_ids: ["x1"] }),
    (error) => error.statusCode === 409 && error.code === "assignee_has_kpis",
  );
  assert.equal(database.calls.some((call) => /^UPDATE projects/.test(call.text)), false);
});

test("updateById: a department change without assignees is refused by the repository itself, and rolls back", async () => {
  const database = fakeDatabase([LOCK_PROJECT]);

  await assert.rejects(
    createProjectRepository(database).updateById(PROJECT, { department_id: D2, team_lead_id: null }),
    (error) => error.statusCode === 400 && error.code === "invalid_request",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("updateById: a scalar-only edit touches no assignment row and runs no KPI check", async () => {
  const database = fakeDatabase([LOCK_PROJECT, projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, { title: "Renamed", status: "completed" });

  assert.equal(database.calls.some((call) => /project_assignments/.test(call.text) && !/FROM project_assignments WHERE project_id = ANY/.test(call.text)), false);
  assert.equal(database.calls.some((call) => /FROM kpis/.test(call.text)), false);
  const update = callStarting(database, "UPDATE projects SET");
  assert.match(update.text, /title = \$1, status = \$2 WHERE id = \$3 AND deleted_at IS NULL/);
  assert.deepEqual(update.values, ["Renamed", "completed", PROJECT]);
});

test("updateById: never writes timestamps or deleted_* columns, even if smuggled in", async () => {
  const database = fakeDatabase([LOCK_PROJECT, projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, {
    title: "t", created_at: "2000-01-01", updated_at: "2000-01-01", deleted_at: "2000-01-01", deleted_by_employee_id: "x", company_id: "other",
  });

  const update = callStarting(database, "UPDATE projects SET");
  const setClause = update.text.slice(0, update.text.indexOf(" WHERE "));
  assert.doesNotMatch(setClause, /created_at|updated_at|deleted|company_id/);
  assert.deepEqual(update.values, ["t", PROJECT]);
});

test("updateById: an assignment-only change still touches the project row, so updated_at advances", async () => {
  const database = fakeDatabase([LOCK_PROJECT, currentAssignees("e1"), projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, { assigned_employee_ids: ["e1", "e2"] });

  const touch = callStarting(database, "UPDATE projects SET title = title");
  assert.ok(touch, "the set_updated_at trigger needs an UPDATE to fire");
  assert.deepEqual(touch.values, [PROJECT]);
});

test("updateById: an empty changes object skips the transaction entirely", async () => {
  const database = fakeDatabase([projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, {});

  assert.equal(database.calls.some((call) => call.text === "BEGIN"), false);
});

test("updateById: a missing or deleted project is null, and the transaction is rolled back", async () => {
  const database = fakeDatabase([[/SELECT department_id FROM projects .* FOR UPDATE/, { rows: [] }]]);

  assert.equal(await createProjectRepository(database).updateById(PROJECT, { title: "x" }), null);
  assert.equal(countOf(database, "ROLLBACK"), 1);
  assert.equal(countOf(database, "COMMIT"), 0);
});

test("updateById: the project row is locked FOR UPDATE and only a live one is touched", async () => {
  const database = fakeDatabase([LOCK_PROJECT, projectSelect()]);

  await createProjectRepository(database).updateById(PROJECT, { title: "x" });

  assert.match(database.calls[1].text, /SELECT department_id FROM projects WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/);
});

test("updateById: a constraint violation partway through rolls back and translates", async () => {
  const database = fakeDatabase([
    LOCK_PROJECT,
    [/^UPDATE projects SET/, { throwError: pgError("23514", "projects_dates_ordered") }],
  ]);

  await assert.rejects(
    createProjectRepository(database).updateById(PROJECT, { due_date: "2000-01-01" }),
    (error) => error.statusCode === 400 && error.code === "invalid_dates",
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
  assert.equal(countOf(database, "COMMIT"), 0);
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

test("deleteById: D29 -- a project with live KPIs is a 409 project_has_kpis carrying the count, and nothing is deleted", async () => {
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis WHERE project_id = \$1 AND deleted_at IS NULL$/, { rows: [{ count: 4 }] }],
  ]);

  await assert.rejects(createProjectRepository(database).deleteById(PROJECT, DELETER), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "project_has_kpis");
    assert.deepEqual(error.details, { live_kpi_count: 4 });
    assert.match(error.message, /\b4\b/);
    return true;
  });
  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE")), false);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: only LIVE KPIs count, so a project whose KPIs are all soft-deleted can be deleted", async () => {
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count: 0 }] }],
  ]);

  await createProjectRepository(database).deleteById(PROJECT, DELETER);

  const count = callStarting(database, "SELECT count(*)::int AS count FROM kpis");
  assert.match(count.text, /deleted_at IS NULL/);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("deleteById: D29 -- soft deletes, setting deleted_at and recording the deleter; never a hard DELETE", async () => {
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count: 0 }] }],
  ]);

  await createProjectRepository(database).deleteById(PROJECT, DELETER);

  const update = callStarting(database, "UPDATE projects");
  assert.match(update.text, /deleted_at = now\(\)/);
  assert.match(update.text, /deleted_by_employee_id = \$2/);
  assert.deepEqual(update.values, [PROJECT, DELETER]);
  assert.equal(database.calls.some((call) => /^DELETE\b/i.test(call.text)), false, "never a hard DELETE");
});

test("deleteById: the assignment rows are left alone -- they are hidden with the project", async () => {
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count: 0 }] }],
  ]);

  await createProjectRepository(database).deleteById(PROJECT, DELETER);

  assert.equal(database.calls.some((call) => /project_assignments/.test(call.text)), false);
});

test("deleteById: the project is locked FOR UPDATE before the KPIs are counted", async () => {
  // A concurrent KPI create takes FOR SHARE on the project row, so the KPI is either counted here
  // or refused there -- never created against a project that is being deleted.
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count: 0 }] }],
  ]);

  await createProjectRepository(database).deleteById(PROJECT, DELETER);

  assert.ok(indexOf(database, /FROM projects .* FOR UPDATE/) < indexOf(database, /FROM kpis/));
});

test("deleteById: a missing or already-deleted project is a clean 404, and rolls back", async () => {
  const database = fakeDatabase([[/SELECT id FROM projects .* FOR UPDATE/, { rows: [] }]]);

  await assert.rejects(createProjectRepository(database).deleteById(PROJECT, DELETER), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

test("deleteById: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    [/SELECT id FROM projects .* FOR UPDATE/, { rows: [{ id: PROJECT }] }],
    [/SELECT count\(\*\)::int AS count FROM kpis/, { rows: [{ count: 0 }] }],
    [/^UPDATE projects/, { throwError: boom }],
  ]);

  await assert.rejects(createProjectRepository(database).deleteById(PROJECT, DELETER), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});
