-- D17 (docs/schema-design.md): employee_number generation, settled as a Postgres sequence.
--
-- Not max(employee_number)+1: employees_number_unique (001) is a partial index on
-- deleted_at IS NULL, so computing the next number from live rows would reissue a
-- soft-deleted employee's number to a new hire, and two employees created at once could
-- compute the same next value. A sequence never goes backwards and is race-free.
--
-- employees.employee_number itself needs no change -- it is already a plain
-- NOT NULL varchar(64) with no default (001). This is only the generation mechanism;
-- every employee-creating caller (the bootstrap script, and later employee-create) does
-- SELECT next_employee_number() and inserts the result.

CREATE SEQUENCE employee_number_seq START WITH 1 INCREMENT BY 1;

-- lpad() TRUNCATES rather than erroring when the target length is shorter than the input
-- (lpad('10000', 4, '0') = '1000', a silent collision with an existing employee_number), so
-- the target length is never a bare 4, only GREATEST(4, actual digit count): pad up to 4
-- digits, never truncate past whatever digits the sequence actually produced.
-- `FROM nextval(...) AS n` calls nextval() exactly once; referencing nextval() twice in one
-- SELECT would silently burn two sequence values per call.
CREATE FUNCTION next_employee_number() RETURNS text
LANGUAGE sql
AS $$
  SELECT 'EMP-' || lpad(n::text, GREATEST(4, length(n::text)), '0')
  FROM nextval('employee_number_seq') AS n;
$$;
