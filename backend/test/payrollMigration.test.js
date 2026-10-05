import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SQL *text* only, like attendanceMigration.test.js -- no database. Executing 008 against a real
// PostgreSQL instance is scripts/e2e-payroll.js's job.

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

const read = (name) => readFile(path.join(migrationsDirectory, name), "utf8");
const stripComments = (sql) => sql.replace(/--.*$/gm, "");

test("008 up: adds deleted_by_employee_id as a nullable uuid FK to employees with ON DELETE SET NULL", async () => {
  const sql = stripComments(await read("008_payroll_deleted_by.up.sql"));

  assert.match(sql, /ALTER TABLE payroll\s+ADD COLUMN deleted_by_employee_id uuid REFERENCES employees\(id\) ON DELETE SET NULL/);
  // An audit pointer must not make hard-deleting an employee impossible, and nullable keeps
  // every pre-existing row valid.
  assert.doesNotMatch(sql, /deleted_by_employee_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /ON DELETE (RESTRICT|CASCADE)/);
});

test("008 up: a deleter may only be recorded on a row that is actually deleted", async () => {
  const sql = stripComments(await read("008_payroll_deleted_by.up.sql"));

  assert.match(sql, /ADD CONSTRAINT payroll_deleted_by_requires_deleted_at/);
  assert.match(sql, /CHECK \(deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL\)/);
});

test("008 up: a partial index serves the ON DELETE SET NULL scan without indexing every live row", async () => {
  const sql = stripComments(await read("008_payroll_deleted_by.up.sql"));

  assert.match(sql, /CREATE INDEX payroll_deleted_by_index\s+ON payroll \(deleted_by_employee_id\) WHERE deleted_by_employee_id IS NOT NULL/);
});

test("008 up: touches only payroll -- not the period uniqueness rule, deleted_at, or the generated columns", async () => {
  const sql = stripComments(await read("008_payroll_deleted_by.up.sql"));

  assert.doesNotMatch(sql, /payroll_employee_period_unique/);
  assert.doesNotMatch(sql, /ADD COLUMN deleted_at/);
  assert.doesNotMatch(sql, /\b(gross|tax|net)\b/);
  assert.doesNotMatch(sql, /ALTER TABLE (?!payroll\b)/);
});

test("008 down: removes the index, constraint and column, then clears its own ledger row", async () => {
  const sql = stripComments(await read("008_payroll_deleted_by.down.sql"));

  assert.match(sql, /DROP INDEX IF EXISTS payroll_deleted_by_index/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS payroll_deleted_by_requires_deleted_at/);
  assert.match(sql, /DROP COLUMN IF EXISTS deleted_by_employee_id/);
  assert.match(sql, /DELETE FROM schema_migrations WHERE id = '008_payroll_deleted_by'/);

  // Dependents before the column, or the DROP COLUMN would have to cascade silently.
  assert.ok(sql.indexOf("DROP INDEX") < sql.indexOf("DROP COLUMN"));
  assert.ok(sql.indexOf("DROP CONSTRAINT") < sql.indexOf("DROP COLUMN"));
});
