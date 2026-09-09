import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "../src/db/migrator.js";
import { getEmployeeScope } from "../src/services/employeeScopeService.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

// These tests assert the migration SQL *text*. They deliberately do not connect to a
// database -- see backend/README.md, where db:migrate is the only command permitted to.
// Executing the DDL against a real PostgreSQL instance is a separate verification step.

async function readUpMigration() {
  const migrations = await loadMigrations(migrationsDirectory);
  assert.equal(migrations.length, 1, "expected exactly one migration; there is no 002");
  assert.equal(migrations[0].id, "001_initial_core_hr_hierarchy");
  return migrations[0].sql;
}

function readDownMigration() {
  return readFile(
    path.join(migrationsDirectory, "001_initial_core_hr_hierarchy.down.sql"),
    "utf8",
  );
}

/** Extract the body of a `CREATE TABLE <name> ( ... );` block. */
function tableBlock(sql, table) {
  const match = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  assert.ok(match, `CREATE TABLE ${table} not found`);
  return match[1];
}

const TABLES = [
  "companies",
  "users",
  "departments",
  "employees",
  "projects",
  "project_assignments",
  "kpis",
  "leaves",
  "attendance",
  "payroll",
];

// Two tables intentionally lack deleted_at: companies is a singleton that is never
// deleted, and project_assignments is a pure join table that is hard-deleted (D1).
const NO_SOFT_DELETE = new Set(["companies", "project_assignments"]);
const SOFT_DELETE_AWARE_TABLES = TABLES.filter((table) => !NO_SOFT_DELETE.has(table));

const ENUMS = {
  user_role: ["admin", "hr", "manager", "tl", "employee"],
  account_status: ["active", "inactive", "invited", "suspended"],
  employment_status: ["active", "inactive", "on_leave", "terminated"],
  leave_type: ["Annual", "Sick", "Casual", "Maternity", "Emergency"],
  leave_status: ["pending", "approved", "rejected"],
  attendance_status: ["present", "absent", "late", "leave"],
  payroll_status: ["draft", "processed"],
  project_status: ["draft", "active", "completed"],
  kpi_status: ["active"],
};

const CONSTRAINTS = [
  "companies_name_not_blank",
  "companies_code_not_blank",
  "companies_code_unique",
  "users_email_not_blank",
  "users_password_hash_not_blank",
  "users_company_id_unique",
  "departments_name_not_blank",
  "departments_company_id_unique",
  "departments_manager_employee_foreign_key",
  "employees_number_not_blank",
  "employees_full_name_not_blank",
  "employees_position_not_blank",
  "employees_basic_non_negative",
  "employees_allowances_non_negative",
  "employees_not_own_team_lead",
  "employees_user_company_foreign_key",
  "employees_department_company_foreign_key",
  "employees_team_lead_department_foreign_key",
  "employees_user_unique",
  "employees_company_id_unique",
  "employees_department_scope_unique",
  "projects_title_not_blank",
  "projects_dates_ordered",
  "projects_department_company_foreign_key",
  "projects_team_lead_department_foreign_key",
  "projects_scope_unique",
  "project_assignments_project_department_foreign_key",
  "project_assignments_employee_department_foreign_key",
  "kpis_title_not_blank",
  "kpis_target_positive",
  "kpis_current_non_negative",
  "kpis_weight_range",
  "kpis_rating_range",
  "kpis_no_self_rating",
  "kpis_legacy_not_rateable",
  "kpis_rating_fields_consistent",
  "leaves_dates_ordered",
  "leaves_reason_not_blank",
  "leaves_no_self_approval",
  "leaves_decision_consistent",
  "attendance_times_ordered",
  "attendance_absent_has_no_times",
  "attendance_timestamps_ordered",
  "payroll_year_range",
  "payroll_month_range",
  "payroll_amounts_non_negative",
];

const INDEXES = [
  "companies_singleton",
  "users_email_unique",
  "users_role_status_index",
  "departments_name_unique",
  "departments_status_index",
  "employees_number_unique",
  "employees_department_status_index",
  "employees_team_lead_index",
  "projects_department_status_index",
  "projects_team_lead_index",
  "project_assignments_employee_index",
  "kpis_employee_index",
  "kpis_project_index",
  "leaves_employee_status_index",
  "leaves_date_range_index",
  "attendance_employee_date_unique",
  "attendance_date_index",
  "payroll_employee_period_unique",
];

// Every uniqueness rule must be partial, or a soft-deleted row permanently reserves the
// value (docs/schema-design.md section 8, item 1).
const PARTIAL_UNIQUE_INDEXES = [
  "users_email_unique",
  "departments_name_unique",
  "employees_number_unique",
  "attendance_employee_date_unique",
  "payroll_employee_period_unique",
];

test("migration creates every table in the schema design", async () => {
  const sql = await readUpMigration();
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`), `missing table ${table}`);
  }
});

test("the teams entity is gone and full_name replaces the split name columns", async () => {
  const sql = await readUpMigration();

  // A team is employees.team_lead_id, matching Firestore's shape.
  assert.doesNotMatch(sql, /CREATE TABLE teams\b/);
  assert.doesNotMatch(sql, /\bteam_id\b/);
  assert.doesNotMatch(sql, /employees_team_scope_foreign_key/);
  assert.doesNotMatch(sql, /teams_team_lead_employee_foreign_key/);

  const employees = tableBlock(sql, "employees");
  assert.doesNotMatch(employees, /\bfirst_name\b/);
  assert.doesNotMatch(employees, /\blast_name\b/);
  assert.match(employees, /full_name\s+varchar\(200\)\s+NOT NULL/);
  assert.match(employees, /team_lead_id\s+uuid/);
});

test("employees carries the compensation columns Firestore has", async () => {
  const employees = tableBlock(await readUpMigration(), "employees");
  assert.match(employees, /basic\s+numeric\(12,2\)\s+NOT NULL/);
  assert.match(employees, /allowances\s+numeric\(12,2\)\s+NOT NULL/);
});

test("every enum is declared with exactly the designed values", async () => {
  const sql = await readUpMigration();
  for (const [name, values] of Object.entries(ENUMS)) {
    const match = new RegExp(`CREATE TYPE ${name}\\s+AS ENUM \\(([^)]*)\\)`).exec(sql);
    assert.ok(match, `missing enum ${name}`);
    const declared = [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
    assert.deepEqual(declared, values, `enum ${name} values differ`);
  }
});

test("the single-company decision is enforced structurally", async () => {
  const sql = await readUpMigration();
  assert.match(sql, /CREATE UNIQUE INDEX companies_singleton ON companies \(\(true\)\)/);
});

test("soft-delete-aware tables carry deleted_at", async () => {
  const sql = await readUpMigration();
  for (const table of SOFT_DELETE_AWARE_TABLES) {
    assert.match(tableBlock(sql, table), /deleted_at\s+timestamptz/, `${table} lacks deleted_at`);
  }
  for (const table of NO_SOFT_DELETE) {
    assert.doesNotMatch(tableBlock(sql, table), /deleted_at/, `${table} should not be soft-deletable`);
  }
});

test("every uniqueness rule is a partial index scoped to live rows", async () => {
  const sql = await readUpMigration();
  for (const index of PARTIAL_UNIQUE_INDEXES) {
    const match = new RegExp(
      `CREATE UNIQUE INDEX ${index}[\\s\\S]*?WHERE deleted_at IS NULL`,
    ).exec(sql);
    assert.ok(match, `${index} is not partial on deleted_at IS NULL`);
  }
});

test("every named constraint from the design exists", async () => {
  const sql = await readUpMigration();
  for (const constraint of CONSTRAINTS) {
    assert.match(sql, new RegExp(`CONSTRAINT ${constraint}\\b`), `missing ${constraint}`);
  }
});

test("every index from the design exists", async () => {
  const sql = await readUpMigration();
  for (const index of INDEXES) {
    assert.match(sql, new RegExp(`INDEX ${index}\\b`), `missing index ${index}`);
  }
});

test("the three preserved bans are database constraints, not service checks", async () => {
  const sql = await readUpMigration();

  // KPI self-rating ban (functions/kpiMutationService.js:616-618)
  assert.match(
    sql,
    /CONSTRAINT kpis_no_self_rating\s*\n?\s*CHECK \(rated_by_employee_id IS NULL OR rated_by_employee_id <> employee_id\)/,
  );

  // Legacy-KPI rating ban (functions/kpiMutationService.js:621-627)
  assert.match(sql, /CONSTRAINT kpis_legacy_not_rateable[\s\S]*?project_id IS NOT NULL/);

  // Leave self-approval ban (firestore.rules:358), broadened to all roles per D8
  assert.match(
    sql,
    /CONSTRAINT leaves_no_self_approval\s*\n?\s*CHECK \(decided_by_employee_id IS NULL OR decided_by_employee_id <> employee_id\)/,
  );
});

test("row-local arithmetic is generated, not merely checked", async () => {
  const sql = await readUpMigration();

  // Leave inclusive day count (firestore.rules:406-411)
  assert.match(
    tableBlock(sql, "leaves"),
    /days\s+integer GENERATED ALWAYS AS \(end_date - start_date \+ 1\) STORED/,
  );

  // Payroll gross/tax/net (firestore.rules:614-615)
  const payroll = tableBlock(sql, "payroll");
  assert.match(payroll, /gross numeric\(12,2\) GENERATED ALWAYS AS \(basic \+ allowances \+ bonus\) STORED/);
  assert.match(payroll, /tax\s+numeric\(12,2\) GENERATED ALWAYS AS \(payroll_tax_for\(basic \+ allowances \+ bonus\)\) STORED/);
  assert.match(payroll, /net\s+numeric\(12,2\) GENERATED ALWAYS AS \([\s\S]*?payroll_tax_for\(basic \+ allowances \+ bonus\)[\s\S]*?\) STORED/);
});

test("payroll_tax_for is immutable, which generated columns require", async () => {
  const sql = await readUpMigration();
  const match = /CREATE OR REPLACE FUNCTION payroll_tax_for\(gross numeric\)\s*\nRETURNS numeric\s*\nLANGUAGE sql\s*\nIMMUTABLE STRICT/.exec(sql);
  assert.ok(match, "payroll_tax_for must be declared IMMUTABLE to back a generated column");
  // numeric, not double precision: PostgreSQL rounds numeric half away from zero and
  // double precision half to even. The bracket table depends on the former.
  assert.match(sql, /payroll_tax_for\(gross numeric\)/);
});

test("the attendance wall-clock checks are deliberately absent from the schema", async () => {
  // "date not in the future" and "updated_at is today" depend on now(), which is not
  // IMMUTABLE; a non-immutable CHECK breaks pg_dump/restore. They live in the service
  // layer (docs/schema-design.md section 5).
  const attendance = tableBlock(await readUpMigration(), "attendance");
  assert.doesNotMatch(attendance, /CURRENT_DATE/);
  assert.doesNotMatch(attendance, /now\(\)\s*\)/);
});

test("the leave usage view replaces the leaveBalances collection", async () => {
  const sql = await readUpMigration();
  // The collection is gone as a table; the name survives only in the comment that
  // explains what the view replaces.
  assert.doesNotMatch(sql, /CREATE TABLE leave_?[Bb]alances\b/);
  assert.match(sql, /CREATE VIEW employee_leave_usage AS/);
  assert.match(sql, /WHERE status = 'approved' AND deleted_at IS NULL/);
});

test("the department manager foreign key restricts rather than nulling", async () => {
  const sql = await readUpMigration();
  assert.match(
    sql,
    /ADD CONSTRAINT departments_manager_employee_foreign_key\s*\n\s*FOREIGN KEY \(manager_employee_id, id\)\s*\n\s*REFERENCES employees \(id, department_id\) ON DELETE RESTRICT/,
  );
  assert.doesNotMatch(sql, /ON DELETE SET NULL/);
});

test("every table and type created is reversed by the down migration", async () => {
  const up = await readUpMigration();
  const down = await readDownMigration();

  for (const table of TABLES) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table};`), `down misses ${table}`);
  }
  for (const name of Object.keys(ENUMS)) {
    assert.match(down, new RegExp(`DROP TYPE IF EXISTS ${name};`), `down misses type ${name}`);
  }

  assert.match(down, /DROP VIEW IF EXISTS employee_leave_usage;/);
  assert.match(down, /DROP FUNCTION IF EXISTS payroll_tax_for\(numeric\);/);
  assert.match(down, /DROP FUNCTION IF EXISTS set_updated_at\(\);/);

  // The circular foreign key must be broken before either table is dropped.
  const constraintDrop = down.indexOf("DROP CONSTRAINT IF EXISTS departments_manager_employee_foreign_key");
  const employeesDrop = down.indexOf("DROP TABLE IF EXISTS employees;");
  assert.ok(constraintDrop > -1 && constraintDrop < employeesDrop);

  // payroll_tax_for backs generated columns, so payroll must go first.
  assert.ok(down.indexOf("DROP TABLE IF EXISTS payroll;") < down.indexOf("DROP FUNCTION IF EXISTS payroll_tax_for"));

  // Every trigger created is dropped.
  for (const [, trigger] of up.matchAll(/CREATE TRIGGER (\w+)/g)) {
    assert.match(down, new RegExp(`DROP TRIGGER IF EXISTS ${trigger}\\b`), `down misses trigger ${trigger}`);
  }
});

test("employee scope foundation models the existing five role boundaries", () => {
  const base = { employeeId: "employee-id", companyId: "company-id" };
  assert.deepEqual(getEmployeeScope({ ...base, role: "admin" }), { type: "company" });
  assert.deepEqual(getEmployeeScope({ ...base, role: "hr" }), { type: "company" });
  assert.deepEqual(
    getEmployeeScope({ ...base, role: "manager", departmentId: "department-id" }),
    { type: "department", departmentId: "department-id" },
  );
  assert.deepEqual(
    getEmployeeScope({ ...base, role: "tl", teamId: "team-id" }),
    { type: "team", teamId: "team-id" },
  );
  assert.deepEqual(getEmployeeScope({ ...base, role: "employee" }), {
    type: "self",
    employeeId: "employee-id",
  });
});
