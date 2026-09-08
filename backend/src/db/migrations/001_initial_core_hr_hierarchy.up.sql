CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'hr', 'manager', 'tl', 'employee');
CREATE TYPE account_status AS ENUM ('active', 'inactive', 'invited', 'suspended');
CREATE TYPE employment_status AS ENUM ('active', 'inactive', 'on_leave', 'terminated');

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  code varchar(32) NOT NULL,
  status account_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT companies_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT companies_code_unique UNIQUE (code)
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name varchar(120) NOT NULL,
  description varchar(1000),
  status account_status NOT NULL DEFAULT 'active',
  manager_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT departments_company_id_unique UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX departments_company_name_unique
  ON departments (company_id, lower(name));
CREATE INDEX departments_company_status_index ON departments (company_id, status);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  department_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  status account_status NOT NULL DEFAULT 'active',
  team_lead_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT teams_department_company_foreign_key
    FOREIGN KEY (department_id, company_id)
    REFERENCES departments (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT teams_scope_unique UNIQUE (id, company_id, department_id)
);

CREATE UNIQUE INDEX teams_department_name_unique
  ON teams (department_id, lower(name));
CREATE INDEX teams_company_department_status_index
  ON teams (company_id, department_id, status);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email varchar(254) NOT NULL,
  password_hash text,
  role user_role NOT NULL,
  status account_status NOT NULL DEFAULT 'invited',
  last_login_at timestamptz,
  password_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0),
  CONSTRAINT users_password_hash_not_blank CHECK (
    password_hash IS NULL OR length(btrim(password_hash)) > 0
  ),
  CONSTRAINT users_company_id_unique UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX users_company_email_unique
  ON users (company_id, lower(email));
CREATE INDEX users_company_role_status_index ON users (company_id, role, status);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  department_id uuid NOT NULL,
  team_id uuid,
  employee_number varchar(64) NOT NULL,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  phone varchar(40),
  position_title varchar(160) NOT NULL,
  employment_status employment_status NOT NULL DEFAULT 'active',
  joined_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_number_not_blank CHECK (length(btrim(employee_number)) > 0),
  CONSTRAINT employees_first_name_not_blank CHECK (length(btrim(first_name)) > 0),
  CONSTRAINT employees_last_name_not_blank CHECK (length(btrim(last_name)) > 0),
  CONSTRAINT employees_position_not_blank CHECK (length(btrim(position_title)) > 0),
  CONSTRAINT employees_user_company_foreign_key
    FOREIGN KEY (user_id, company_id)
    REFERENCES users (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT employees_department_company_foreign_key
    FOREIGN KEY (department_id, company_id)
    REFERENCES departments (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT employees_team_scope_foreign_key
    FOREIGN KEY (team_id, company_id, department_id)
    REFERENCES teams (id, company_id, department_id) ON DELETE RESTRICT,
  CONSTRAINT employees_user_unique UNIQUE (user_id),
  CONSTRAINT employees_company_number_unique UNIQUE (company_id, employee_number),
  CONSTRAINT employees_company_id_unique UNIQUE (id, company_id),
  CONSTRAINT employees_department_scope_unique UNIQUE (id, company_id, department_id),
  CONSTRAINT employees_team_scope_unique UNIQUE (id, company_id, department_id, team_id)
);

CREATE INDEX employees_company_department_status_index
  ON employees (company_id, department_id, employment_status);
CREATE INDEX employees_company_team_status_index
  ON employees (company_id, team_id, employment_status);

ALTER TABLE departments
  ADD CONSTRAINT departments_manager_employee_foreign_key
  FOREIGN KEY (manager_employee_id, company_id, id)
  REFERENCES employees (id, company_id, department_id) ON DELETE SET NULL;

ALTER TABLE teams
  ADD CONSTRAINT teams_team_lead_employee_foreign_key
  FOREIGN KEY (team_lead_employee_id, company_id, department_id, id)
  REFERENCES employees (id, company_id, department_id, team_id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER departments_set_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employees_set_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
