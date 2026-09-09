-- Initial schema for the Firebase -> PostgreSQL migration.
-- Implements docs/schema-design.md in full. See that document for the mapping of every
-- table and column back to its Firestore source.
--
-- Settled decisions encoded here:
--   D1  soft delete for employees, payroll and leaves; hard delete elsewhere.
--       deleted_at is present on every business table and every uniqueness rule is a
--       partial index WHERE deleted_at IS NULL.
--   D2  this file is rewritten in place; there is no 002. 001 was never applied.
--   D15 departments.manager_employee_id uses ON DELETE RESTRICT, not SET NULL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE user_role         AS ENUM ('admin', 'hr', 'manager', 'tl', 'employee');
CREATE TYPE account_status    AS ENUM ('active', 'inactive', 'invited', 'suspended');
CREATE TYPE employment_status AS ENUM ('active', 'inactive', 'on_leave', 'terminated');

-- leave_type keeps Firestore's title-case vocabulary verbatim so the ETL is a straight
-- copy (firestore.rules:368-418). Status enums are lowercase, matching every other
-- system value; departments.status must be case-folded by the ETL.
CREATE TYPE leave_type        AS ENUM ('Annual', 'Sick', 'Casual', 'Maternity', 'Emergency');
CREATE TYPE leave_status      AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'leave');
CREATE TYPE payroll_status    AS ENUM ('draft', 'processed');
CREATE TYPE project_status    AS ENUM ('draft', 'active', 'completed');

-- Exactly one value, because ALLOWED_KPI_STATUSES = new Set(["active"])
-- (functions/kpiMutationService.js:7). Carried forward unresolved as ambiguity A1.
CREATE TYPE kpi_status        AS ENUM ('active');

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Progressive payroll tax, transcribed from calculatedPayrollTax at
-- firestore.rules:549-559. That function rounds the whole expression including the
-- bracket constant; rounding a value then adding an integer is equivalent, so the
-- constants sit outside round() here. backend/test/payrollTax.test.js proves the two
-- forms agree at every bracket boundary.
--
-- IMMUTABLE is required because payroll.tax and payroll.net are generated columns.
-- Consequence: replacing this function does NOT recompute already-stored rows.
-- Changing the bracket table means a data migration, not just CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION payroll_tax_for(gross numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN gross <= 50000  THEN 0
    WHEN gross <= 100000 THEN round((gross - 50000)  * 0.05)
    WHEN gross <= 200000 THEN round((gross - 100000) * 0.10) + 2500
    ELSE                      round((gross - 200000) * 0.15) + 12500
  END;
$$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- companies -- no Firestore source; exactly one row
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(160) NOT NULL,
  code        varchar(32)  NOT NULL,
  status      account_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT companies_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT companies_code_unique UNIQUE (code)
);

-- Enforces "single company" structurally: at most one row can ever exist.
CREATE UNIQUE INDEX companies_singleton ON companies ((true));

-- ---------------------------------------------------------------------------
-- users -- from authLinks + the auth half of the employees documents
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email               varchar(254) NOT NULL,
  password_hash       text,
  role                user_role NOT NULL,
  status              account_status NOT NULL DEFAULT 'invited',
  last_login_at       timestamptz,
  password_updated_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0),
  CONSTRAINT users_password_hash_not_blank CHECK (
    password_hash IS NULL OR length(btrim(password_hash)) > 0
  ),
  CONSTRAINT users_company_id_unique UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX users_email_unique
  ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_role_status_index
  ON users (role, status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- departments -- from the departments collection
-- ---------------------------------------------------------------------------

CREATE TABLE departments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name                varchar(120) NOT NULL,
  description         varchar(1000),
  status              account_status NOT NULL DEFAULT 'active',
  manager_employee_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT departments_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT departments_company_id_unique UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX departments_name_unique
  ON departments (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX departments_status_index
  ON departments (status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- employees -- from the employees collection
-- ---------------------------------------------------------------------------

CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  company_id        uuid NOT NULL,
  department_id     uuid NOT NULL,
  team_lead_id      uuid,
  employee_number   varchar(64)  NOT NULL,
  full_name         varchar(200) NOT NULL,
  phone             varchar(40),
  position_title    varchar(160) NOT NULL,
  employment_status employment_status NOT NULL DEFAULT 'active',
  joined_on         date NOT NULL,
  basic             numeric(12,2) NOT NULL DEFAULT 0,
  allowances        numeric(12,2) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT employees_number_not_blank        CHECK (length(btrim(employee_number)) > 0),
  CONSTRAINT employees_full_name_not_blank     CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT employees_position_not_blank      CHECK (length(btrim(position_title)) > 0),
  CONSTRAINT employees_basic_non_negative      CHECK (basic >= 0),
  CONSTRAINT employees_allowances_non_negative CHECK (allowances >= 0),
  CONSTRAINT employees_not_own_team_lead       CHECK (team_lead_id IS NULL OR team_lead_id <> id),

  CONSTRAINT employees_user_company_foreign_key
    FOREIGN KEY (user_id, company_id)
    REFERENCES users (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT employees_department_company_foreign_key
    FOREIGN KEY (department_id, company_id)
    REFERENCES departments (id, company_id) ON DELETE RESTRICT,

  -- A team lead must be in the SAME DEPARTMENT as their member. Enforced structurally,
  -- replacing the application check at functions/employeeMutationService.js:506-508.
  -- ON DELETE RESTRICT is what makes TL reassignment mandatory: the row cannot be
  -- deleted while members still point at it. Note this fires only on a hard DELETE;
  -- under the D1 soft-delete policy for employees, the reassignment requirement is
  -- enforced by the service layer (docs/schema-design.md section 8, item 2).
  CONSTRAINT employees_team_lead_department_foreign_key
    FOREIGN KEY (team_lead_id, department_id)
    REFERENCES employees (id, department_id) ON DELETE RESTRICT,

  CONSTRAINT employees_user_unique             UNIQUE (user_id),
  CONSTRAINT employees_company_id_unique       UNIQUE (id, company_id),
  CONSTRAINT employees_department_scope_unique UNIQUE (id, department_id)
);

CREATE UNIQUE INDEX employees_number_unique
  ON employees (employee_number) WHERE deleted_at IS NULL;
CREATE INDEX employees_department_status_index
  ON employees (department_id, employment_status) WHERE deleted_at IS NULL;
CREATE INDEX employees_team_lead_index
  ON employees (team_lead_id) WHERE deleted_at IS NULL AND team_lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- projects -- from the projects collection
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  department_id uuid NOT NULL,
  team_lead_id  uuid,
  title         varchar(200) NOT NULL,
  description   varchar(2000) NOT NULL,
  start_date    date NOT NULL,
  due_date      date NOT NULL,
  status        project_status NOT NULL DEFAULT 'draft',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT projects_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT projects_dates_ordered   CHECK (due_date >= start_date),
  CONSTRAINT projects_department_company_foreign_key
    FOREIGN KEY (department_id, company_id)
    REFERENCES departments (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT projects_team_lead_department_foreign_key
    FOREIGN KEY (team_lead_id, department_id)
    REFERENCES employees (id, department_id) ON DELETE RESTRICT,
  CONSTRAINT projects_scope_unique UNIQUE (id, department_id)
);

CREATE INDEX projects_department_status_index
  ON projects (department_id, status) WHERE deleted_at IS NULL;
CREATE INDEX projects_team_lead_index
  ON projects (team_lead_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- project_assignments -- from projects.assignedEmployeeIds[]
-- ---------------------------------------------------------------------------

-- department_id is carried redundantly so the two composite foreign keys force the
-- project and the assignee into the same department, replacing the application check
-- at functions/projectMutationService.js:478-509.
CREATE TABLE project_assignments (
  project_id    uuid NOT NULL,
  employee_id   uuid NOT NULL,
  department_id uuid NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, employee_id),
  CONSTRAINT project_assignments_project_department_foreign_key
    FOREIGN KEY (project_id, department_id)
    REFERENCES projects (id, department_id) ON DELETE CASCADE,
  CONSTRAINT project_assignments_employee_department_foreign_key
    FOREIGN KEY (employee_id, department_id)
    REFERENCES employees (id, department_id) ON DELETE RESTRICT
);

CREATE INDEX project_assignments_employee_index ON project_assignments (employee_id);

-- ---------------------------------------------------------------------------
-- kpis -- from the kpis collection
-- ---------------------------------------------------------------------------

CREATE TABLE kpis (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id) ON DELETE RESTRICT,  -- NULL = legacy KPI
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  title                 varchar(200) NOT NULL,
  target                numeric(14,2) NOT NULL,
  current_value         numeric(14,2) NOT NULL DEFAULT 0,
  weight                integer NOT NULL,
  period                varchar(40) NOT NULL,
  status                kpi_status NOT NULL DEFAULT 'active',
  rating                integer,
  rated_by_employee_id  uuid REFERENCES employees(id) ON DELETE RESTRICT,
  rated_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT kpis_title_not_blank      CHECK (length(btrim(title)) > 0),
  CONSTRAINT kpis_target_positive      CHECK (target > 0),
  CONSTRAINT kpis_current_non_negative CHECK (current_value >= 0),
  CONSTRAINT kpis_weight_range         CHECK (weight BETWEEN 1 AND 100),
  CONSTRAINT kpis_rating_range         CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),

  -- KPI self-rating ban (functions/kpiMutationService.js:616-618)
  CONSTRAINT kpis_no_self_rating
    CHECK (rated_by_employee_id IS NULL OR rated_by_employee_id <> employee_id),

  -- Legacy-KPI rating ban (functions/kpiMutationService.js:621-627):
  -- a KPI with no project cannot be rated.
  CONSTRAINT kpis_legacy_not_rateable
    CHECK (
      project_id IS NOT NULL
      OR (rating IS NULL AND rated_by_employee_id IS NULL AND rated_at IS NULL)
    ),

  -- rating, rater and timestamp move together
  CONSTRAINT kpis_rating_fields_consistent
    CHECK (num_nulls(rating, rated_by_employee_id, rated_at) IN (0, 3))
);

CREATE INDEX kpis_employee_index
  ON kpis (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX kpis_project_index
  ON kpis (project_id) WHERE deleted_at IS NULL AND project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- leaves -- from the leaves collection
-- ---------------------------------------------------------------------------

CREATE TABLE leaves (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  type                   leave_type   NOT NULL,
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  -- Inclusive day count, from firestore.rules:406-411. Generated, so it cannot
  -- disagree with the dates it derives from.
  days                   integer GENERATED ALWAYS AS (end_date - start_date + 1) STORED,
  reason                 varchar(2000) NOT NULL,
  status                 leave_status NOT NULL DEFAULT 'pending',
  applied_on             date NOT NULL,
  decided_by_employee_id uuid REFERENCES employees(id) ON DELETE RESTRICT,
  decided_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,

  CONSTRAINT leaves_dates_ordered    CHECK (end_date >= start_date),
  CONSTRAINT leaves_reason_not_blank CHECK (length(btrim(reason)) > 0),

  -- Self-approval ban. Firestore restricts this to team leads (firestore.rules:358);
  -- a CHECK cannot see the approver's role, so this is broader and blocks everyone.
  -- Carried as decision D8.
  CONSTRAINT leaves_no_self_approval
    CHECK (decided_by_employee_id IS NULL OR decided_by_employee_id <> employee_id),

  -- pending has no decision; approved/rejected must have one
  CONSTRAINT leaves_decision_consistent CHECK (
    (status =  'pending' AND decided_by_employee_id IS NULL     AND decided_at IS NULL) OR
    (status <> 'pending' AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX leaves_employee_status_index
  ON leaves (employee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leaves_date_range_index
  ON leaves (start_date, end_date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- attendance -- from the attendance collection
-- ---------------------------------------------------------------------------

-- The "date not in the future" and "updated_at is today" checks from
-- firestore.rules:461-463 and :520-530 are deliberately NOT here: they depend on
-- wall-clock now(), which is not IMMUTABLE, and a non-immutable CHECK is re-evaluated
-- on pg_dump/restore. They live in the service layer instead
-- (docs/schema-design.md section 5).
CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date   date NOT NULL,
  status      attendance_status NOT NULL,
  check_in    time,
  check_out   time,
  notes       varchar(2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT attendance_times_ordered
    CHECK (check_in IS NULL OR check_out IS NULL OR check_out > check_in),

  -- absent/leave forces both times empty (firestore.rules:448-496)
  CONSTRAINT attendance_absent_has_no_times
    CHECK (status NOT IN ('absent', 'leave') OR (check_in IS NULL AND check_out IS NULL)),

  CONSTRAINT attendance_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX attendance_employee_date_unique
  ON attendance (employee_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX attendance_date_index
  ON attendance (work_date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- payroll -- from the payroll collection
-- ---------------------------------------------------------------------------

-- gross, tax and net are GENERATED, not stored inputs. This makes an incorrect tax or
-- net figure unrepresentable rather than merely rejected, replacing the write-time
-- assertions at firestore.rules:614-615. A generated column cannot reference another
-- generated column, so net calls payroll_tax_for() again rather than reading tax.
CREATE TABLE payroll (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  period_year  integer NOT NULL,
  period_month integer NOT NULL,
  basic        numeric(12,2) NOT NULL,
  allowances   numeric(12,2) NOT NULL DEFAULT 0,
  bonus        numeric(12,2) NOT NULL DEFAULT 0,
  deductions   numeric(12,2) NOT NULL DEFAULT 0,

  gross numeric(12,2) GENERATED ALWAYS AS (basic + allowances + bonus) STORED,
  tax   numeric(12,2) GENERATED ALWAYS AS (payroll_tax_for(basic + allowances + bonus)) STORED,
  net   numeric(12,2) GENERATED ALWAYS AS (
          basic + allowances + bonus - deductions
          - payroll_tax_for(basic + allowances + bonus)
        ) STORED,

  status      payroll_status NOT NULL DEFAULT 'processed',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT payroll_year_range  CHECK (period_year BETWEEN 1 AND 9999),
  CONSTRAINT payroll_month_range CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT payroll_amounts_non_negative
    CHECK (basic >= 0 AND allowances >= 0 AND bonus >= 0 AND deductions >= 0)
);

CREATE UNIQUE INDEX payroll_employee_period_unique
  ON payroll (employee_id, period_year, period_month) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Circular foreign key, added once employees exists
-- ---------------------------------------------------------------------------

-- The department manager must be an employee OF THAT DEPARTMENT. RESTRICT rather than
-- SET NULL, so a department cannot be silently left without a manager (decision D15).
ALTER TABLE departments
  ADD CONSTRAINT departments_manager_employee_foreign_key
  FOREIGN KEY (manager_employee_id, id)
  REFERENCES employees (id, department_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- employee_leave_usage -- replaces the leaveBalances collection
-- ---------------------------------------------------------------------------

-- Usage only. Entitlement has no authoritative source yet (decision D4), so the
-- remaining balance r = t - u cannot be computed until entitlement is defined.
CREATE VIEW employee_leave_usage AS
SELECT employee_id,
       type,
       date_part('year', start_date)::int AS leave_year,
       sum(days) AS days_used
FROM leaves
WHERE status = 'approved' AND deleted_at IS NULL
GROUP BY employee_id, type, date_part('year', start_date);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER departments_set_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employees_set_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kpis_set_updated_at
  BEFORE UPDATE ON kpis
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leaves_set_updated_at
  BEFORE UPDATE ON leaves
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER attendance_set_updated_at
  BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payroll_set_updated_at
  BEFORE UPDATE ON payroll
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
