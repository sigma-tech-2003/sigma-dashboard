-- Reverses 009_project_kpi_deleted_by.up.sql.
--
-- As with 001-008, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP INDEX IF EXISTS kpis_deleted_by_index;
ALTER TABLE kpis DROP CONSTRAINT IF EXISTS kpis_deleted_by_requires_deleted_at;
ALTER TABLE kpis DROP COLUMN IF EXISTS deleted_by_employee_id;

DROP INDEX IF EXISTS projects_deleted_by_index;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_deleted_by_requires_deleted_at;
ALTER TABLE projects DROP COLUMN IF EXISTS deleted_by_employee_id;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '009_project_kpi_deleted_by';
  END IF;
END $$;
