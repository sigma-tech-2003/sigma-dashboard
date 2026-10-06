import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SQL *text* only, like payrollMigration.test.js -- no database. Executing 009 against a real
// PostgreSQL instance is scripts/e2e-projects-kpis.js's job.

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

const read = (name) => readFile(path.join(migrationsDirectory, name), "utf8");
const stripComments = (sql) => sql.replace(/--.*$/gm, "");

for (const table of ["projects", "kpis"]) {
  test(`009 up: adds deleted_by_employee_id to ${table} as a nullable uuid FK to employees with ON DELETE SET NULL`, async () => {
    const sql = stripComments(await read("009_project_kpi_deleted_by.up.sql"));

    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN deleted_by_employee_id uuid REFERENCES employees\\(id\\) ON DELETE SET NULL`));
  });

  test(`009 up: a deleter may only be recorded on a ${table} row that is actually deleted`, async () => {
    const sql = stripComments(await read("009_project_kpi_deleted_by.up.sql"));

    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+ADD CONSTRAINT ${table}_deleted_by_requires_deleted_at\\s+CHECK \\(deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL\\)`));
  });

  test(`009 up: a partial index serves the ON DELETE SET NULL scan on ${table} without indexing every live row`, async () => {
    const sql = stripComments(await read("009_project_kpi_deleted_by.up.sql"));

    assert.match(sql, new RegExp(`CREATE INDEX ${table}_deleted_by_index\\s+ON ${table} \\(deleted_by_employee_id\\) WHERE deleted_by_employee_id IS NOT NULL`));
  });
}

test("009 up: the audit pointer is nullable and never RESTRICT or CASCADE -- it must not block hard-deleting an employee", async () => {
  const sql = stripComments(await read("009_project_kpi_deleted_by.up.sql"));

  assert.doesNotMatch(sql, /deleted_by_employee_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /ON DELETE (RESTRICT|CASCADE)/);
});

test("009 up: touches only projects and kpis, and leaves the soft-delete column, the assignments and the rating constraints alone", async () => {
  const sql = stripComments(await read("009_project_kpi_deleted_by.up.sql"));

  assert.doesNotMatch(sql, /ADD COLUMN deleted_at/);
  assert.doesNotMatch(sql, /project_assignments/);
  assert.doesNotMatch(sql, /kpis_no_self_rating|kpis_legacy_not_rateable|kpis_rating_fields_consistent|kpis_rating_range/);
  assert.doesNotMatch(sql, /ALTER TABLE (?!projects\b|kpis\b)/);
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 4, "two tables, a column and a constraint each");
});

test("009 down: removes both tables' index, constraint and column -- dependents before the column -- then clears its own ledger row", async () => {
  const sql = stripComments(await read("009_project_kpi_deleted_by.down.sql"));

  for (const table of ["projects", "kpis"]) {
    assert.match(sql, new RegExp(`DROP INDEX IF EXISTS ${table}_deleted_by_index`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_deleted_by_requires_deleted_at`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} DROP COLUMN IF EXISTS deleted_by_employee_id`));

    // Dependents before the column, or the DROP COLUMN would have to cascade silently.
    const column = sql.indexOf(`ALTER TABLE ${table} DROP COLUMN`);
    assert.ok(sql.indexOf(`DROP INDEX IF EXISTS ${table}_deleted_by_index`) < column, `${table} index before column`);
    assert.ok(sql.indexOf(`ALTER TABLE ${table} DROP CONSTRAINT`) < column, `${table} constraint before column`);
  }
  assert.match(sql, /DELETE FROM schema_migrations WHERE id = '009_project_kpi_deleted_by'/);
});
