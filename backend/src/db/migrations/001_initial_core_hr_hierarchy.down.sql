-- Reverses 001_initial_core_hr_hierarchy.up.sql.
--
-- NOTE: src/db/migrator.js loads only *.up.sql (MIGRATION_FILE_PATTERN at migrator.js:4),
-- so this file is never executed by any code path. It is maintained as documentation and
-- for manual rollback. Whether the migrator should support down migrations is carried as
-- ambiguity A13 in docs/auth-matrix.md.
--
-- Order matters in three places:
--   1. the view is dropped before the table it reads
--   2. the circular departments -> employees foreign key is dropped before either table
--   3. payroll_tax_for() is dropped after payroll, because its generated columns depend on it

DROP TRIGGER IF EXISTS payroll_set_updated_at     ON payroll;
DROP TRIGGER IF EXISTS attendance_set_updated_at  ON attendance;
DROP TRIGGER IF EXISTS leaves_set_updated_at      ON leaves;
DROP TRIGGER IF EXISTS kpis_set_updated_at        ON kpis;
DROP TRIGGER IF EXISTS projects_set_updated_at    ON projects;
DROP TRIGGER IF EXISTS employees_set_updated_at   ON employees;
DROP TRIGGER IF EXISTS departments_set_updated_at ON departments;
DROP TRIGGER IF EXISTS users_set_updated_at       ON users;
DROP TRIGGER IF EXISTS companies_set_updated_at   ON companies;

DROP VIEW IF EXISTS employee_leave_usage;

-- Break the circular dependency before dropping either side.
ALTER TABLE IF EXISTS departments
  DROP CONSTRAINT IF EXISTS departments_manager_employee_foreign_key;

DROP TABLE IF EXISTS payroll;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS leaves;
DROP TABLE IF EXISTS kpis;
DROP TABLE IF EXISTS project_assignments;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS companies;

DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS payroll_tax_for(numeric);

DROP TYPE IF EXISTS kpi_status;
DROP TYPE IF EXISTS project_status;
DROP TYPE IF EXISTS payroll_status;
DROP TYPE IF EXISTS attendance_status;
DROP TYPE IF EXISTS leave_status;
DROP TYPE IF EXISTS leave_type;
DROP TYPE IF EXISTS employment_status;
DROP TYPE IF EXISTS account_status;
DROP TYPE IF EXISTS user_role;

-- Clear this migration's ledger row. runMigrations() records the id in
-- schema_migrations when the up migration runs; without this DELETE the ledger keeps
-- claiming the migration is applied after everything it created has been dropped, and
-- the next db:migrate reports "Database is current" against an empty database and
-- creates nothing. rollbackLastMigration() aborts if this row survives.
--
-- Guarded so the file stays runnable against a database that never had it applied,
-- matching the IF EXISTS style of every statement above.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '001_initial_core_hr_hierarchy';
  END IF;
END $$;
