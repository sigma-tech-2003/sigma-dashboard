-- Reverses 012_temporary_passwords.up.sql.
--
-- As with 001-011, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP INDEX IF EXISTS users_must_change_password_index;

ALTER TABLE users
  DROP COLUMN IF EXISTS password_set_by_employee_id,
  DROP COLUMN IF EXISTS must_change_password;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '012_temporary_passwords';
  END IF;
END $$;
