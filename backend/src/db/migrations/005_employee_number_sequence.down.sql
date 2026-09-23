-- Reverses 005_employee_number_sequence.up.sql.
--
-- As with 001-004, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP FUNCTION IF EXISTS next_employee_number();
DROP SEQUENCE IF EXISTS employee_number_seq;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '005_employee_number_sequence';
  END IF;
END $$;
