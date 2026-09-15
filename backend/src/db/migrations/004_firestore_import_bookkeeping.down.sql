-- Reverses 004_firestore_import_bookkeeping.up.sql.
--
-- As with 001, 002 and 003, this file is only reachable through `npm run db:rollback`,
-- which requires --confirm-database=<name>.

DROP TABLE IF EXISTS firestore_import_refs;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '004_firestore_import_bookkeeping';
  END IF;
END $$;
