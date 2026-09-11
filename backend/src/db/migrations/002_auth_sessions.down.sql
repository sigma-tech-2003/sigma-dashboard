-- Reverses 002_auth_sessions.up.sql.
--
-- Dropping the table drops its indexes with it, so they are not listed separately.
--
-- As with 001, this file is only reachable through `npm run db:rollback`, which requires
-- --confirm-database=<name>. See the header of 001_initial_core_hr_hierarchy.down.sql.

DROP TABLE IF EXISTS refresh_tokens;

-- Clear this migration's ledger row. runMigrations() records the id in
-- schema_migrations when the up migration runs; without this DELETE the ledger keeps
-- claiming the migration is applied after everything it created has been dropped, and
-- the next db:migrate reports "Database is current" against a database missing this
-- table. rollbackLastMigration() aborts if this row survives.
--
-- Guarded so the file stays runnable against a database that never had it applied,
-- matching the IF EXISTS style of the statement above.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '002_auth_sessions';
  END IF;
END $$;
