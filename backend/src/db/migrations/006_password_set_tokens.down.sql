-- Reverses 006_password_set_tokens.up.sql.
--
-- As with 001-005, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP TABLE IF EXISTS password_set_tokens;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '006_password_set_tokens';
  END IF;
END $$;
