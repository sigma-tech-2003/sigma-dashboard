import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SQL *text* only, like projectKpiMigration.test.js -- no database. Executing 010 against a real
// PostgreSQL instance, and the replaced view's per-month numbers in particular, is
// scripts/e2e-leaves.js's job.

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

const read = (name) => readFile(path.join(migrationsDirectory, name), "utf8");
const stripComments = (sql) => sql.replace(/--.*$/gm, "");
const UP = "010_leave_deleted_by_and_usage_view.up.sql";
const DOWN = "010_leave_deleted_by_and_usage_view.down.sql";

test("010 up: adds deleted_by_employee_id to leaves as a nullable uuid FK to employees with ON DELETE SET NULL", async () => {
  const sql = stripComments(await read(UP));

  assert.match(sql, /ALTER TABLE leaves\s+ADD COLUMN deleted_by_employee_id uuid REFERENCES employees\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(sql, /deleted_by_employee_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /ON DELETE (RESTRICT|CASCADE)/);
});

test("010 up: a deleter may only be recorded on a leave that is actually deleted", async () => {
  const sql = stripComments(await read(UP));

  assert.match(sql, /ADD CONSTRAINT leaves_deleted_by_requires_deleted_at\s+CHECK \(deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL\)/);
});

test("010 up: a partial index serves the ON DELETE SET NULL scan without indexing every live row", async () => {
  const sql = stripComments(await read(UP));

  assert.match(sql, /CREATE INDEX leaves_deleted_by_index\s+ON leaves \(deleted_by_employee_id\) WHERE deleted_by_employee_id IS NOT NULL/);
});

test("010 up: replaces the view with DROP then CREATE -- CREATE OR REPLACE cannot change a view's columns", async () => {
  const sql = stripComments(await read(UP));

  assert.match(sql, /DROP VIEW employee_leave_usage;/);
  assert.match(sql, /CREATE VIEW employee_leave_usage AS/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE VIEW/);
  assert.ok(sql.indexOf("DROP VIEW") < sql.indexOf("CREATE VIEW"));
});

test("010 up: the view exposes exactly employee, type, year, month and the two day counts -- and not 001's columns", async () => {
  const sql = stripComments(await read(UP));
  const view = sql.slice(sql.indexOf("CREATE VIEW"));

  for (const column of [
    "leaves.employee_id", "leaves.type", "AS usage_year", "AS usage_month", "AS days_approved", "AS days_pending",
  ]) {
    assert.ok(view.includes(column), column);
  }
  assert.doesNotMatch(view, /leave_year|days_used/);
});

test("010 up: the view splits every leave per calendar day, so a month-spanning leave is charged to each month it covers", async () => {
  const view = stripComments(await read(UP));

  assert.match(view, /CROSS JOIN LATERAL generate_series\(\s*leaves\.start_date::timestamp, leaves\.end_date::timestamp, interval '1 day'\s*\)/);
  assert.match(view, /date_part\('year', leave_dates\.leave_date\)::int\s+AS usage_year/);
  assert.match(view, /date_part\('month', leave_dates\.leave_date\)::int AS usage_month/);
  assert.match(view, /GROUP BY 1, 2, 3, 4/, "grouped by employee, type, year and month");
});

test("010 up: only approved and pending leaves count, deleted ones never do, and the statuses are separate columns", async () => {
  const sql = stripComments(await read(UP));

  assert.match(sql, /WHERE leaves\.status IN \('approved', 'pending'\) AND leaves\.deleted_at IS NULL/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE leaves\.status = 'approved'\)\)::int AS days_approved/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE leaves\.status = 'pending'\)\)::int\s+AS days_pending/);
  assert.doesNotMatch(sql, /status = 'rejected'/);
});

test("010 up: the view is a pure usage fact -- it knows no pool, allowance or leave-type map", async () => {
  const sql = stripComments(await read(UP));

  assert.doesNotMatch(sql, /Annual|Casual|Sick|Maternity|Emergency/);
  assert.doesNotMatch(sql, /allowance|entitle|monthly|serious/i);
});

test("010 up: touches only leaves and the usage view -- no other table, and not the soft-delete or decision columns", async () => {
  const sql = stripComments(await read(UP));

  assert.doesNotMatch(sql, /ALTER TABLE (?!leaves\b)/);
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 2, "a column and a constraint");
  assert.doesNotMatch(sql, /ADD COLUMN deleted_at/);
  assert.doesNotMatch(sql, /decision_recorded|leaves_no_self_approval|leaves_decision_consistent|leaves_dates_ordered/);
});

test("010 down: restores 001's view exactly -- year and type, a whole leave attributed to its start year", async () => {
  const sql = stripComments(await read(DOWN));

  assert.match(sql, /DROP VIEW IF EXISTS employee_leave_usage;/);
  assert.match(sql, /CREATE VIEW employee_leave_usage AS/);
  assert.match(sql, /date_part\('year', start_date\)::int AS leave_year/);
  assert.match(sql, /sum\(days\) AS days_used/);
  assert.match(sql, /WHERE status = 'approved' AND deleted_at IS NULL/);
  assert.match(sql, /GROUP BY employee_id, type, date_part\('year', start_date\)/);
});

test("010 down: matches 001's own view text, so a rollback really does return to the original", async () => {
  const original = stripComments(await read("001_initial_core_hr_hierarchy.up.sql"));
  const restored = stripComments(await read(DOWN));
  const body = (sql) => sql.slice(sql.indexOf("CREATE VIEW employee_leave_usage"))
    .split(";")[0].replace(/\s+/g, " ").trim();

  assert.equal(body(restored), body(original));
});

test("010 down: drops the view before the column's dependents, then the index, constraint and column, then clears its ledger row", async () => {
  const sql = stripComments(await read(DOWN));

  assert.match(sql, /DROP INDEX IF EXISTS leaves_deleted_by_index/);
  assert.match(sql, /ALTER TABLE leaves DROP CONSTRAINT IF EXISTS leaves_deleted_by_requires_deleted_at/);
  assert.match(sql, /ALTER TABLE leaves DROP COLUMN IF EXISTS deleted_by_employee_id/);
  assert.ok(sql.indexOf("DROP INDEX") < sql.indexOf("DROP CONSTRAINT"));
  assert.ok(sql.indexOf("DROP CONSTRAINT") < sql.indexOf("DROP COLUMN"));
  assert.match(sql, /DELETE FROM schema_migrations WHERE id = '010_leave_deleted_by_and_usage_view'/);
});

// ---------------------------------------------------------------------------
// 011 (D40): restores employee_leave_usage to its pre-010 shape. 010 is applied and is never edited, so
// the pool-era view it created is still described, accurately, by the tests above; 011 supersedes it.
// ---------------------------------------------------------------------------

const UP_011 = "011_restore_leave_usage_view.up.sql";
const DOWN_011 = "011_restore_leave_usage_view.down.sql";
const viewBody = (sql) => sql.slice(sql.indexOf("CREATE VIEW employee_leave_usage"))
  .replace(/GROUP BY 1, 2, 3, 4;[\s\S]*$/, "GROUP BY 1, 2, 3, 4;")
  .split(";")[0].replace(/\s+/g, " ").trim();

test("011 up: drops the view and creates it again -- CREATE OR REPLACE cannot change a view's columns", async () => {
  const sql = stripComments(await read(UP_011));

  assert.match(sql, /DROP VIEW employee_leave_usage;/);
  assert.match(sql, /CREATE VIEW employee_leave_usage AS/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE VIEW/);
  assert.ok(sql.indexOf("DROP VIEW") < sql.indexOf("CREATE VIEW"));
});

test("011 up: the view's definition is 001's, character for character apart from whitespace", async () => {
  const original = stripComments(await read("001_initial_core_hr_hierarchy.up.sql"));
  const restored = stripComments(await read(UP_011));
  const body = (sql) => sql.slice(sql.indexOf("CREATE VIEW employee_leave_usage")).split(";")[0].replace(/\s+/g, " ").trim();

  assert.equal(body(restored), body(original));
});

test("011 up: exposes exactly employee_id, type, leave_year and days_used -- and none of 010's per-month columns", async () => {
  const sql = stripComments(await read(UP_011));
  const view = sql.slice(sql.indexOf("CREATE VIEW"));

  assert.match(view, /SELECT employee_id,\s+type,\s+date_part\('year', start_date\)::int AS leave_year,\s+sum\(days\) AS days_used/);
  assert.doesNotMatch(view, /usage_year|usage_month|days_approved|days_pending|generate_series/);
});

test("011 up: counts approved, undeleted leave only, grouped by employee, type and the year the leave starts in", async () => {
  const sql = stripComments(await read(UP_011));

  assert.match(sql, /WHERE status = 'approved' AND deleted_at IS NULL/);
  assert.doesNotMatch(sql, /'pending'|'rejected'/);
  assert.match(sql, /GROUP BY employee_id, type, date_part\('year', start_date\)/);
});

test("011 up: touches only the view -- no table, column, constraint or index", async () => {
  const sql = stripComments(await read(UP_011));

  assert.doesNotMatch(sql, /ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN|CREATE INDEX|DROP INDEX|ADD CONSTRAINT|DROP CONSTRAINT/);
  assert.doesNotMatch(sql, /deleted_by_employee_id/, "010's deleter column, CHECK and index are left alone");
  assert.equal((sql.match(/DROP VIEW/g) ?? []).length, 1);
  assert.equal((sql.match(/CREATE VIEW/g) ?? []).length, 1);
});

test("011 down: puts back 010's per-month view exactly, so a rollback returns to the state 010 left", async () => {
  const restored = stripComments(await read(DOWN_011));
  const original = stripComments(await read(UP));

  assert.match(restored, /DROP VIEW IF EXISTS employee_leave_usage;/);
  assert.equal(viewBody(restored), viewBody(original));
  assert.match(restored, /usage_year/);
  assert.match(restored, /generate_series/);
});

test("011 down: clears its own ledger row, guarded against a missing ledger table, and touches nothing else", async () => {
  const sql = stripComments(await read(DOWN_011));

  assert.match(sql, /DELETE FROM schema_migrations WHERE id = '011_restore_leave_usage_view'/);
  assert.match(sql, /to_regclass\('public\.schema_migrations'\) IS NOT NULL/);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP COLUMN|DROP INDEX|DROP CONSTRAINT/, "010's deleter column stays when only 011 is rolled back");
});
