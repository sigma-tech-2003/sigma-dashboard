-- Reverses 008_payroll_deleted_by.up.sql.
--
-- As with 001-007, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP INDEX IF EXISTS payroll_deleted_by_index;
ALTER TABLE payroll DROP CONSTRAINT IF EXISTS payroll_deleted_by_requires_deleted_at;
ALTER TABLE payroll DROP COLUMN IF EXISTS deleted_by_employee_id;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '008_payroll_deleted_by';
  END IF;
END $$;
