# PostgreSQL schema design

Target schema for the Firebase → Postgres migration, written against the settled product
decisions. Every table maps explicitly to its Firestore source, documented in
[firebase-inventory.md](firebase-inventory.md) and [auth-matrix.md](auth-matrix.md).

**Status: implemented.** `backend/src/db/migrations/001_initial_core_hr_hierarchy.up.sql`
and its `.down.sql` now implement this design in full, and `backend/test/` asserts it.
The migration has not been applied to any database — see [§9 D2](#d2--rewrite-001-or-add-002).

Sequencing is in [migration-plan.md](migration-plan.md). Open decisions are in [§9](#9-decisions-i-need-from-you).

---

## 1. Settled decisions this design implements

| Decision | Schema consequence |
|---|---|
| Single company | `companies` kept, **exactly one row** enforced by a singleton index; `company_id` retained on top-level tables |
| No `teams` entity | `teams` table **dropped**; a team is `employees.team_lead_id`, matching Firestore |
| `full_name` single column | replaces `first_name` + `last_name` |
| Five roles, unchanged | `user_role` enum kept as-is |
| Manager deletes tl/employee in own dept; tl deletes own members | authorization is service-layer; schema provides the scope columns and blocks orphaning |
| TL deletion requires a replacement from that TL's own members | `ON DELETE RESTRICT` on `employees.team_lead_id` — the database refuses to orphan |
| Leave balances computed, not stored | `leaveBalances` **dropped**; a view derives usage from `leaves` |
| TL self-approval ban, KPI self-rating ban, legacy-KPI rating ban | all three as `CHECK` constraints |
| **Soft delete for `employees`, `payroll` and `leaves`; hard delete elsewhere** (D1) | `deleted_at` on every business table except `companies` (singleton) and `project_assignments` (pure join); every uniqueness rule is a partial index `WHERE deleted_at IS NULL`. [§8](#8-soft-vs-hard-delete--every-place-the-choice-matters) records what the choice changes |

---

## 2. What changes from the existing migration `001`

`001` was written before these decisions. It does not match and must be reconciled.

| `001` today | Required | Why |
|---|---|---|
| `first_name` + `last_name`, both NOT NULL (`:86-87`) | `full_name varchar(200) NOT NULL` | decided; also removes an unsolvable split of Firestore's single `name` |
| `teams` table (`:36-55`) | **dropped** | decided: no separate teams entity |
| `employees.team_id` + `employees_team_scope_foreign_key` (`:84`, `:104-106`) | `employees.team_lead_id` self-FK | a team is the TL pointer |
| `teams_team_lead_employee_foreign_key` (`:124-127`) | dropped with the table | — |
| no compensation columns | `basic`, `allowances numeric(12,2)` | Firestore has them (`employeeMutationService.js:14-15`), gated by `PAYROLL_ROLES` |
| `companies` unconstrained row count | singleton index | decided: single company |
| no `deleted_at` anywhere | `deleted_at` on business tables | soft/hard delete undecided |
| six collections have no table | `projects`, `project_assignments`, `kpis`, `leaves`, `attendance`, `payroll` | the bulk of the product |
| `ON DELETE SET NULL` on `departments.manager_employee_id` (`:122`) | `ON DELETE RESTRICT` | "required reassignment, not a nullable orphan" applies to managers as it does to TLs — see [§9 D15](#d15--does-required-reassignment-extend-to-department-managers) |

Retained from `001` as-is: the `user_role` enum, the `set_updated_at()` trigger function and
its per-table triggers, `pgcrypto`/`gen_random_uuid()`, and the composite-FK technique that
keeps related rows inside the same scope.

---

## 3. Enums

```sql
CREATE TYPE user_role         AS ENUM ('admin','hr','manager','tl','employee');
CREATE TYPE account_status    AS ENUM ('active','inactive','invited','suspended');
CREATE TYPE employment_status AS ENUM ('active','inactive','on_leave','terminated');

CREATE TYPE leave_type        AS ENUM ('Annual','Sick','Casual','Maternity','Emergency');
CREATE TYPE leave_status      AS ENUM ('pending','approved','rejected');
CREATE TYPE attendance_status AS ENUM ('present','absent','late','leave');
CREATE TYPE payroll_status    AS ENUM ('draft','processed');
CREATE TYPE project_status    AS ENUM ('draft','active','completed');
CREATE TYPE kpi_status        AS ENUM ('active');
```

`user_role` is unchanged from `001:3`. The five new enums encode value sets that
`firestore.rules` enforced as string literals — `leaveHasValidFields` (`:368-418`),
`attendanceHasValidFields` (`:448-496`), `payrollHasValidFields` (`:561-618`) — and
`projectMutationService.js:35` / `kpiMutationService.js:7`.

> `leave_type` keeps Firestore's **title-case** values verbatim (`Annual`, not `annual`) so the
> ETL is a straight copy and the frontend needs no mapping. `departments.status` is the
> opposite case — Firestore stores title-case `'Active'|'Inactive'` (`firestore.rules:763`)
> but `account_status` is lowercase, so the ETL must case-fold. That asymmetry is
> deliberate: `leave_type` is a domain vocabulary shown in the UI; `status` is a system value
> already lowercase everywhere else.

> `kpi_status` has exactly one value because `ALLOWED_KPI_STATUSES = new Set(["active"])`
> (`kpiMutationService.js:7`). This is carried forward unresolved — see
> [§9 D19](#d19--carried-forward-unresolved-ambiguities) (A1).

---

## 4. Tables

### 4.1 `companies` — no Firestore source

```sql
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
```

**Firestore source: none.** This resolves ambiguity A12 by decision — one seeded row, no
multi-tenancy. `company_id` is retained on top-level tables rather than dropped because
the composite foreign keys that keep departments, employees and projects in the same scope
are built on it, and because removing it later is a far smaller change than adding it back.

### 4.2 `users` — from `authLinks` + the auth half of `employees`

```sql
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
CREATE INDEX users_role_status_index ON users (role, status) WHERE deleted_at IS NULL;
```

| Firestore | Column | Note |
|---|---|---|
| `authLinks/{uid}` doc id | `id` | the whole `authLinks` collection collapses into this PK |
| `employees.uid` | — | Firebase UID is not carried forward; `users.id` replaces it |
| `employees.email` | `email` | moves to `users`; email is an identity attribute |
| `employees.role` | `role` | **moves to `users`** — see below |
| `employees.status` | `status` | `active`/`inactive` map directly; `invited` covers the `inviteEmployee` pre-password state |
| — | `password_hash` | new; Firebase Auth held the credential |

**Why `role` lives on `users`, not `employees`.** Firestore puts `role` on the employee
document and every rule reads `currentEmployeeData().role` (`firestore.rules:107`). Here,
role is an *identity* attribute that must be resolvable at authentication time to build the
request principal and sign a token, whereas department and team-lead scope are *organizational*
attributes. Splitting them costs exactly one join, executed once per request during principal
resolution, and keeps the token-issuing path independent of the org chart. Confirm at
[§9 D6](#d6--role-on-users-rather-than-employees).

`authLinks`' bijection invariant — validated at runtime today by
`canonicalRelationshipMigration.js:356-393` — becomes the `employees_user_unique` constraint
in §4.4. The migration turns a script-checked invariant into a structural one.

### 4.3 `departments` — from `departments`

```sql
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
CREATE INDEX departments_status_index ON departments (status) WHERE deleted_at IS NULL;
```

| Firestore | Column |
|---|---|
| doc id / legacy `id` / `_docId` | `id` — the three-way legacy id tolerance disappears |
| `name` | `name` — **stops being a foreign key**; `employees.dept` matched on this string |
| `description` | `description` |
| `managerId` | `manager_employee_id` |
| `status` `'Active'\|'Inactive'` | `status` — **ETL must lowercase** |
| `createdAt` (ISO string) | `created_at timestamptz` |

The `manager_employee_id` FK is added after `employees` exists (§4.10) because the
dependency is circular.

### 4.4 `employees` — from `employees`

```sql
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

  CONSTRAINT employees_number_not_blank    CHECK (length(btrim(employee_number)) > 0),
  CONSTRAINT employees_full_name_not_blank CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT employees_position_not_blank  CHECK (length(btrim(position_title)) > 0),
  CONSTRAINT employees_basic_non_negative      CHECK (basic >= 0),
  CONSTRAINT employees_allowances_non_negative CHECK (allowances >= 0),
  CONSTRAINT employees_not_own_team_lead   CHECK (team_lead_id IS NULL OR team_lead_id <> id),

  CONSTRAINT employees_user_company_foreign_key
    FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT employees_department_company_foreign_key
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE RESTRICT,

  -- A team lead must be in the SAME DEPARTMENT as their member. Enforced structurally.
  -- RESTRICT is what makes TL reassignment mandatory: the row cannot be deleted while
  -- members still point at it.
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
```

| Firestore | Column | Note |
|---|---|---|
| doc id | `id` | Firebase UID for invited employees, numeric string for legacy — both become uuid |
| `uid` | — | replaced by `user_id` → `users.id` |
| `empId` (`EMP-<uid>`) | `employee_number` | cosmetic in Firestore; here it is the human-facing id. Generation rule needs deciding — [§9 D17](#d17--employee_number-generation) |
| `name` | `full_name` | **single column, per decision** — the unsolvable split is gone |
| `email` | — | moved to `users.email` |
| `role` | — | moved to `users.role` |
| `status` | `employment_status` | `active`/`inactive` map directly |
| `dept` (department **name**) | `department_id` | ETL resolves name → uuid |
| `teamLeadId` | `team_lead_id` | self-FK, same shape as Firestore |
| `pos` | `position_title` | |
| `joinDate` (`YYYY-MM-DD`) | `joined_on date` | |
| `basic`, `allowances` | `basic`, `allowances` | **were entirely missing from `001`** |
| `phone` | `phone` | |
| `createdByUid` | — | **dropped**: written but never read anywhere |
| `createdAt`, `updatedAt` | `created_at`, `updated_at` | |

**Two invariants the schema enforces that Firestore enforced only in application code:**

1. **A team lead is in the same department as their members.** Firestore checks this in
   `employeeMutationService.js:506-508` and `projectMutationService.js:478-509`. Here the
   composite FK `(team_lead_id, department_id) → (id, department_id)` makes a cross-department
   assignment impossible to write, from any client, including `psql`.
2. **A team lead cannot be deleted while members point at them.** `ON DELETE RESTRICT`.

**Two invariants that cannot be schema-enforced and stay in the service layer:**

1. **Only `employee`-role people may have a `team_lead_id`** (`employeeMutationService.js:410-414`).
   `role` is on `users`, and a `CHECK` cannot read another table.
2. **The person named by `team_lead_id` must have role `tl`.** Same reason. A trigger could
   do it; a trigger is proposed in [§9 D18](#d18--triggers-for-cross-table-role-invariants) rather
   than assumed.

### 4.5 `projects` — from `projects`

```sql
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
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT projects_team_lead_department_foreign_key
    FOREIGN KEY (team_lead_id, department_id)
    REFERENCES employees (id, department_id) ON DELETE RESTRICT,
  CONSTRAINT projects_scope_unique UNIQUE (id, department_id)
);

CREATE INDEX projects_department_status_index
  ON projects (department_id, status) WHERE deleted_at IS NULL;
CREATE INDEX projects_team_lead_index
  ON projects (team_lead_id) WHERE deleted_at IS NULL;
```

`projects_dates_ordered` replaces `projectMutationService.js:321-329`. The legacy `name`
field — readable but unwritable (`PROTECTED_PROJECT_FIELDS`, `:21-34`) — is **dropped**; the
ETL coalesces `title` then `name`.

### 4.6 `project_assignments` — from `projects.assignedEmployeeIds[]`

```sql
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
```

The Firestore array becomes a junction table. `department_id` is carried redundantly so the
two composite FKs force **project and assignee into the same department** — which
`projectMutationService.js:478-509` checks in application code today.

`ON DELETE CASCADE` on the project side means deleting a project removes its assignment rows;
`RESTRICT` on the employee side means an assigned employee cannot be hard-deleted. See
[§8](#8-soft-vs-hard-delete--every-place-the-choice-matters).

> This also removes the `array-contains` / `array-contains-any` query pattern and the
> `MAX_QUERY_VALUES = 30` chunking in `scopedWorkspaceService.js:5,274-280` — a join replaces
> both.

### 4.7 `kpis` — from `kpis`

```sql
CREATE TABLE kpis (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id) ON DELETE RESTRICT,   -- NULL = legacy KPI
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

  -- KPI self-rating ban (kpiMutationService.js:616-618)
  CONSTRAINT kpis_no_self_rating
    CHECK (rated_by_employee_id IS NULL OR rated_by_employee_id <> employee_id),

  -- Legacy-KPI rating ban (kpiMutationService.js:621-627): a KPI with no project cannot be rated
  CONSTRAINT kpis_legacy_not_rateable
    CHECK (project_id IS NOT NULL OR (rating IS NULL AND rated_by_employee_id IS NULL AND rated_at IS NULL)),

  -- rating, rater and timestamp move together
  CONSTRAINT kpis_rating_fields_consistent
    CHECK (num_nulls(rating, rated_by_employee_id, rated_at) IN (0, 3))
);

CREATE INDEX kpis_employee_index ON kpis (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX kpis_project_index  ON kpis (project_id)  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
```

**Two of the three preserved bans live here as constraints.** `kpis_no_self_rating` and
`kpis_legacy_not_rateable` are pure row-local predicates, so the database can guarantee them
absolutely — no service bug, no future admin script, and no direct `psql` session can violate
them. That is strictly stronger than `kpiMutationService.js`, where they are `if` statements
in one code path.

`kpis_rating_fields_consistent` has no Firestore equivalent; it prevents the half-rated rows
that `kpiMutationService.js:769-777` avoids only by writing all three fields together.

### 4.8 `leaves` — from `leaves`

```sql
CREATE TABLE leaves (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id             uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  type                    leave_type   NOT NULL,
  start_date              date NOT NULL,
  end_date                date NOT NULL,
  days                    integer GENERATED ALWAYS AS (end_date - start_date + 1) STORED,
  reason                  varchar(2000) NOT NULL,
  status                  leave_status NOT NULL DEFAULT 'pending',
  applied_on              date NOT NULL,
  decided_by_employee_id  uuid REFERENCES employees(id) ON DELETE RESTRICT,
  decided_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,

  CONSTRAINT leaves_dates_ordered   CHECK (end_date >= start_date),
  CONSTRAINT leaves_reason_not_blank CHECK (length(btrim(reason)) > 0),

  -- Self-approval ban. Firestore restricts this to TLs (firestore.rules:358);
  -- this is broader. See §9 D8.
  CONSTRAINT leaves_no_self_approval
    CHECK (decided_by_employee_id IS NULL OR decided_by_employee_id <> employee_id),

  -- pending has no decision; approved/rejected must have one
  CONSTRAINT leaves_decision_consistent CHECK (
    (status = 'pending'  AND decided_by_employee_id IS NULL AND decided_at IS NULL) OR
    (status <> 'pending' AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX leaves_employee_status_index ON leaves (employee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leaves_date_range_index      ON leaves (start_date, end_date) WHERE deleted_at IS NULL;
```

**`days` is a generated column, not a stored value.** `firestore.rules:406-411` requires
`days == (end - start)/86400000 + 1` and rejects the write otherwise. Postgres computes it,
so the field cannot disagree with the dates it derives from. `date - date` yields an integer
day count in Postgres, so the expression is exact and immutable.

`decided_by_employee_id` / `decided_at` are **new**. Firestore's `canUpdateLeave`
(`:428-438`) permits changing only `status`, so there is no record of who approved a leave.
Adding it is required to enforce the self-approval ban in the database at all, and is an
audit improvement.

### 4.9 `attendance` — from `attendance`

```sql
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
    CHECK (status NOT IN ('absent','leave') OR (check_in IS NULL AND check_out IS NULL)),

  CONSTRAINT attendance_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX attendance_employee_date_unique
  ON attendance (employee_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX attendance_date_index ON attendance (work_date) WHERE deleted_at IS NULL;
```

Firestore's `checkIn`/`checkOut` are `HH:MM` strings or `""` (`isValidAttendanceTime`,
`:440-446`). Here they are `time` with `NULL` for absent, so the empty-string sentinel
disappears; the ETL maps `""` → `NULL`.

`attendance_employee_date_unique` is **new** — Firestore permits unlimited duplicate rows for
the same employee and day. See [§9 D9](#d9--attendance-uniqueness).

**The "date not in the future" check is deliberately absent here** — see §5.

### 4.10 `payroll` — from `payroll`

```sql
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

  CONSTRAINT payroll_year_range   CHECK (period_year BETWEEN 1 AND 9999),
  CONSTRAINT payroll_month_range  CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT payroll_amounts_non_negative
    CHECK (basic >= 0 AND allowances >= 0 AND bonus >= 0 AND deductions >= 0)
);

CREATE UNIQUE INDEX payroll_employee_period_unique
  ON payroll (employee_id, period_year, period_month) WHERE deleted_at IS NULL;
```

Firestore stores `month` as an **English month name** (`firestore.rules:600-612`); this uses
`period_month integer` so periods sort and range-query correctly. The ETL maps names → 1-12
and the API formats back for display.

**`gross`, `tax` and `net` are generated columns** — see §5 for why.

`payroll_tax_for` is a separate `IMMUTABLE` function so the bracket table exists in exactly
one place; a generated column cannot reference another generated column, so `net` calls the
function again rather than reading `tax`.

### 4.11 Circular foreign key, added last

```sql
ALTER TABLE departments
  ADD CONSTRAINT departments_manager_employee_foreign_key
  FOREIGN KEY (manager_employee_id, id)
  REFERENCES employees (id, department_id) ON DELETE RESTRICT;
```

Same technique as `001:119-122`, with two changes: `company_id` drops out of the key (single
company), and `ON DELETE SET NULL` becomes `ON DELETE RESTRICT` so a department manager
cannot be silently orphaned — mirroring the TL rule. See [§9 D15](#d15--does-required-reassignment-extend-to-department-managers).

### 4.12 `leaveBalances` — dropped

Per decision, balances are computed. A view replaces the collection:

```sql
CREATE VIEW employee_leave_usage AS
SELECT employee_id,
       type,
       date_part('year', start_date)::int AS leave_year,
       sum(days) AS days_used
FROM leaves
WHERE status = 'approved' AND deleted_at IS NULL
GROUP BY employee_id, type, date_part('year', start_date);
```

This computes **usage** only. Entitlement — the `t` in Firestore's `{t,u,r}` — has no
authoritative source anywhere in the repo; the only values are mock data in
`src/data/leaveBalance.js` (Annual 15, Sick 10, Casual 5). The remaining balance
`r = t - u` cannot be computed until entitlement is defined. See
[§9 D4](#d4--where-do-leave-entitlements-come-from) — **this blocks the leave domain.**

Note this also resolves ambiguity A2 by decision: balances were stale because nothing
decremented them. Deriving from `leaves` makes staleness structurally impossible.

---

## 5. Where each `firestore.rules` validation goes, and why

| Validation | Firestore | New home | Why there |
|---|---|---|---|
| **Payroll tax brackets** | `calculatedPayrollTax` (`:549-559`), asserted on write (`:614`) | **DB — `payroll_tax_for()` + generated column** | Pure function of columns in the same row. As a generated column it is not *checked*, it is *computed*, so an incorrect tax is unrepresentable — no service bug, admin script or `psql` session can produce one. Rules could only reject a bad write from one client. |
| **Net invariant** `net = gross − deductions − tax` | `:615` | **DB — generated column** | Same reasoning. Removes the A6 failure mode where a row off by a cent became unreadable: there is nothing to disagree with. |
| **Leave day count** `days = end − start + 1` | `:406-411` | **DB — generated column** | Pure, immutable, row-local. `date - date` is exact integer arithmetic. |
| **Attendance: `checkOut > checkIn`** | `:448-496` | **DB — `CHECK`** | Row-local comparison. |
| **Attendance: `absent`/`leave` ⇒ no times** | `:448-496` | **DB — `CHECK`** | Row-local. |
| **Attendance: `createdAt <= updatedAt`** | `:448-496` | **DB — `CHECK`** | Row-local. |
| **Attendance: `date` not in the future** | `:461-463` | **Service layer (Zod + service)** | Depends on wall-clock `now()`, which is **not `IMMUTABLE`**. Postgres permits non-immutable `CHECK` expressions but they are re-evaluated on `pg_dump`/restore, so a table containing yesterday's valid rows can fail to reload tomorrow. Correctness of the backup path outweighs having the check in the DB. |
| **Attendance: `updatedAt` is today** | `:520-530` | **Service layer** | Same wall-clock reason. Also arguably an artifact of client-authored timestamps — the server now sets `updated_at` via the `set_updated_at()` trigger, so the check is largely obsolete. |
| **Leave: `applied` is today** | `:425` | **Service layer** | Wall-clock. |
| **Leave: `status` transitions** `pending → approved\|rejected` | `:428-438` | **Service layer**, with `leaves_decision_consistent` as a backstop | A transition depends on the *previous* row state. `CHECK` sees only the new row. A trigger could compare `OLD`/`NEW`; deferred to [§9 D18](#d18--triggers-for-cross-table-role-invariants). |
| **TL self-approval ban** | `:358` | **DB — `CHECK` `leaves_no_self_approval`** | Row-local once `decided_by_employee_id` is stored. Broader than Firestore — [§9 D8](#d8--self-approval-ban-is-broader-than-firestores). |
| **KPI self-rating ban** | `kpiMutationService.js:616-618` | **DB — `CHECK` `kpis_no_self_rating`** | Row-local. |
| **Legacy-KPI rating ban** | `kpiMutationService.js:621-627` | **DB — `CHECK` `kpis_legacy_not_rateable`** | Row-local. |
| **Enumerated value sets** (leave type, statuses) | string literals in rules | **DB — enum types** | Cheaper and stricter than `CHECK … IN (…)`, and self-documenting to any client. |
| **Team lead in same department** | `employeeMutationService.js:506-508` | **DB — composite FK** | Expressible as a key relationship, so it should be one. |
| **Team lead has role `tl`; only employees have a team lead** | `employeeMutationService.js:410-414` | **Service layer** (trigger optional) | `role` lives on `users`; a `CHECK` cannot read another table. |
| **All role/scope authorization** (`canReadEmployee`, `canManageCanonicalEmployeeRecord`, `ROLE_ASSIGNMENTS`, `PAYROLL_ROLES`, deletion authority) | rules + callables | **Service layer** | Depends on the *requesting principal*, which the database does not know. Row-Level Security could push it down but requires setting a per-request session variable on every pooled connection — a large change with real footguns. Not proposed; raised at [§9 D14](#d14--row-level-security). |
| **Field allow/denylists** (`password`, `uid`, `empId`, `claims`…) | four denylists in `functions/` | **Service layer — Zod schemas** | Input shaping is a transport concern. Zod `.strict()` rejects unknown keys by default, which subsumes all four denylists. |

**The pattern:** anything that is a pure function of one row goes in the database, where it
cannot be bypassed. Anything depending on wall-clock time, another table, or the caller's
identity goes in the service layer, where it can be tested and where a `pg_dump` restore
will not trip over it.

---

## 6. Authorization model in the new stack

Enforced in `backend/src/services`, above the repositories, using the scope descriptor
already sketched at `backend/src/services/employeeScopeService.js:7-17`.

Principal, resolved once per request from the token:

```
{ userId, employeeId, role, departmentId, isTeamLead }
```

Scope predicate per role, applied as a `WHERE` clause:

| Role | Scope | Predicate |
|---|---|---|
| `admin` | global | (none) |
| `hr` | global | (none) |
| `manager` | department | `employees.department_id = :principalDepartmentId` |
| `tl` | own members | `employees.team_lead_id = :principalEmployeeId OR employees.id = :principalEmployeeId` |
| `employee` | self | `employees.id = :principalEmployeeId` |

For `leaves`, `attendance`, `payroll`, `kpis`, the same predicate applies via join on
`employee_id`. This replaces `canReadCanonicalEmployeeRecord` (`firestore.rules:304-329`) and
the per-role read plans in `src/firebase/useFirestore.js:510-549`.

**Write authority, incorporating the decided change:**

| Actor | May create | May update | May delete |
|---|---|---|---|
| `admin` | anyone | anyone | anyone but self |
| `hr` | manager, tl, employee | manager, tl, employee | manager, tl, employee; **not departments** |
| `manager` | tl, employee in own dept | tl, employee in own dept | **tl, employee in own dept** ← changed |
| `tl` | employee assigned to them | employee assigned to them | **employee assigned to them** ← changed |
| `employee` | — | — | — |

Changed from Firestore, which permits deletion only to admin and HR
(`employeeMutationService.js:421-423`). Retained from Firestore: `SELF_DELETE_DENIED`,
`SELF_ROLE_CHANGE_DENIED`, and `PAYROLL_ROLES = {admin, hr}` for `basic`/`allowances`.

**HR cannot write departments** — decided, and it matches `firestore.rules:768,773,786`. This
resolves ambiguity A4 on the rules side. The *frontend* half of A4 remains open: HR is still
shown department write buttons at `src/firebase/useDepartments.js:18`, which will now fail
against the API exactly as they fail against rules today.

### 6.1 The TL replacement flow

Required reassignment, modeled as a single transaction. `DELETE /api/v1/employees/:id`
where the target has role `tl` **must** carry a `replacementTeamLeadId`.

```
BEGIN;
  -- 1. authorize: caller is admin, hr, or the manager of the target's department
  -- 2. validate: replacement.team_lead_id = target.id   (a member of THIS tl's team)
  -- 3. promote:  users.role := 'tl' for the replacement
  UPDATE employees SET team_lead_id = NULL        WHERE id = :replacementId;
  UPDATE employees SET team_lead_id = :replacementId
    WHERE team_lead_id = :targetId AND id <> :replacementId;
  -- 4. delete or soft-delete the target
COMMIT;
```

Step 2 is what "from that tl's own members" means; step 3 is implied by the promotion. The
`ON DELETE RESTRICT` in §4.4 is the safety net: if the service ever forgets step, the delete
fails loudly rather than orphaning rows.

**Edge case with no decided answer:** a TL with zero members has no possible replacement. See
[§9 D16](#d16--deleting-a-tl-who-has-no-members).

---

## 7. Full table inventory and Firestore mapping

| Postgres table | Firestore source | Status |
|---|---|---|
| `companies` | none | new; exactly one row |
| `users` | `authLinks` + `employees.{uid,email,role,status}` | restructured |
| `departments` | `departments` | mapped; name stops being an FK |
| `employees` | `employees` | mapped; `full_name`, compensation added |
| `projects` | `projects` | new table |
| `project_assignments` | `projects.assignedEmployeeIds[]` | array → junction |
| `kpis` | `kpis` | new table |
| `leaves` | `leaves` | new table; `days` generated |
| `attendance` | `attendance` | new table |
| `payroll` | `payroll` | new table; `gross`/`tax`/`net` generated |
| `employee_leave_usage` (view) | `leaveBalances` | collection dropped, usage derived |
| ~~`teams`~~ | none | **removed per decision** |
| ~~`leaveBalances`~~ | `leaveBalances` | **removed per decision** |

All nine Firestore collections are accounted for: seven map to tables, `authLinks` collapses
into `users`, and `leaveBalances` becomes a view.

---

## 8. Soft vs hard delete — every place the choice matters

**Settled (D1): soft delete for `employees`, `payroll` and `leaves`; hard delete everywhere
else.** `deleted_at timestamptz` is carried on every business table except `companies` (a
singleton that is never deleted) and `project_assignments` (a pure join row). The points
below are where that choice has consequences — items 1-4 are now answered, items 5-9 remain
open and are called out as such:

1. **Unique indexes.** Every uniqueness rule is written `WHERE deleted_at IS NULL`
   (`users_email_unique`, `employees_number_unique`, `departments_name_unique`,
   `attendance_employee_date_unique`, `payroll_employee_period_unique`). Under hard delete the
   partial clause is harmless and can be dropped. Under soft delete it is **required**, or a
   soft-deleted employee permanently reserves their email and employee number.

2. **`ON DELETE RESTRICT` never fires under soft delete.** The TL-reassignment guarantee in
   §4.4 is a *database* guarantee only for hard delete. Under soft delete, `UPDATE … SET
   deleted_at` bypasses every FK, and the reassignment requirement becomes service-layer only.
   **This is the most important consequence:** the strongest structural protection in the
   design is inert under soft delete unless backed by a trigger.

3. **Every read query needs `deleted_at IS NULL`.** Under soft delete, one missed filter leaks
   deleted records. This argues for exposing views (`active_employees`, …) rather than base
   tables to the repository layer.

4. **Dependent history.** Deleting an employee with leaves, attendance, payroll and KPIs:
   hard delete requires choosing `CASCADE` (history vanishes — unacceptable for payroll) or
   `RESTRICT` (employees with any history can never be deleted, which in practice means every
   employee). Soft delete sidesteps it. Currently drafted as `RESTRICT` everywhere, which
   under hard delete makes most deletions impossible.

5. **Payroll and statutory retention.** Payroll rows are financial records. Hard-deleting them
   may be legally impermissible regardless of the general policy. Payroll may need to be
   soft-delete-only even if everything else is hard.

6. **Uniqueness of re-hires.** If an employee is soft-deleted and later re-hired with the same
   email, the partial index permits a new row. Under hard delete the old record is simply gone.
   Whether a re-hire should reuse the original `employees.id` is undecided.

7. **The computed leave-balance view.** `employee_leave_usage` filters `deleted_at IS NULL`.
   Whether a soft-deleted leave should still count against a balance — the case for it is
   audit accuracy, against it is that a mistakenly filed leave should not consume entitlement —
   is undecided.

8. **Ambiguity A6 interacts.** Firestore's orphan problem (`/leaves` `allow delete: if false`
   plus validators-on-read) is what made deleted employees' records unreadable. Soft delete
   preserves the reference and eliminates the orphan class entirely; hard delete with
   `RESTRICT` also does, by preventing the delete. Hard delete with `CASCADE` reintroduces it.

9. **ETL idempotency.** Re-running the Firestore import must not resurrect soft-deleted rows.
   The importer needs an explicit rule for records deleted in Postgres but still present in
   Firestore.

---

## 9. Decisions I need from you

Everything below is either explicitly undecided, a choice I made that you should confirm, or
an ambiguity carried forward from the earlier documents rather than silently resolved.

### D1 — Soft or hard delete — ✅ SETTLED
**Soft delete for `employees`, `payroll` and `leaves`; hard delete everywhere else.**
Implemented: `deleted_at` on every business table except `companies` and
`project_assignments`, and every uniqueness rule is partial on `deleted_at IS NULL`.

Consequence to carry into Phase 1, restated because it is easy to lose: **`ON DELETE
RESTRICT` does not fire on a soft delete.** `employees` is soft-deleted, so the
database-level guarantee that a team lead cannot be orphaned (§4.4) only applies to a hard
`DELETE`. Under the settled policy the TL-reassignment requirement is a **service-layer
obligation**, with the foreign key as a backstop for any code path that does hard-delete.
§8 items 5-9 remain open.

### D2 — Rewrite `001` or add `002` — ✅ SETTLED
**`001` has never been applied to any database; it is rewritten in place. There is no `002`.**
Implemented: `001_initial_core_hr_hierarchy.up.sql` and `.down.sql` now match this document,
and `backend/test/migrationFoundation.test.js` asserts `migrations.length === 1`.

### D3 — Realtime behavior is lost — ✅ SETTLED (polling)
**Polling, not WebSockets or SSE.** No schema consequence; recorded here so it is not
relitigated.

`src/services/firestoreService.js:393` uses `onSnapshot`, so the app is live-updating today:
approve a leave and every open dashboard reflects it immediately. Under polling it will not.

**This leaves an unresolved conflict with `AGENTS.md` §1**, which states *"During any backend
or database migration, the existing frontend architecture and UI behavior must stay
unchanged."* Polling changes perceived UI behavior, so either that rule needs amending or the
migration knowingly departs from it. The decision is settled; **the rule text has not been
touched** — see [§9 D20](#d20--agentsmd-1-still-forbids-the-polling-decision).

### D4 — Where do leave entitlements come from?
Balances are now computed, but only *usage* is derivable. Entitlement exists nowhere except
mock data (`src/data/leaveBalance.js`: Annual 15, Sick 10, Casual 5, uniform). Needed: is
entitlement a global constant per leave type, per role, per employee, or accrued over time?
Does it reset on a calendar or fiscal year? Does unused entitlement carry over? **This blocks
the entire leave domain** — without it `r = t − u` cannot be computed and the leave UI cannot
render.

### D5 — Does an approved leave in a prior year still count?
`employee_leave_usage` groups by `date_part('year', start_date)`. A leave spanning a year
boundary is attributed entirely to its start year. Confirm, or specify proration.

### D6 — `role` on `users` rather than `employees`
Firestore keeps role on the employee document. I put it on `users` (§4.2 rationale). Confirm.
Reversing this later means moving a column every authorization path reads.

### D7 — Generated `tax` and `net` remove manual override forever
Making them generated columns means no one can ever record a manually adjusted tax figure —
not through the API, not through `psql`. That exactly matches Firestore's behavior today.
Confirm no payroll correction workflow needs an override. If one does, `tax` must become a
plain column with a `CHECK`, which is weaker.

### D8 — Self-approval ban is broader than Firestore's
Firestore bans self-approval **only for TLs** (`firestore.rules:358`); admin, HR and managers
are not blocked. `leaves_no_self_approval` blocks everyone, because a `CHECK` cannot see the
approver's role. Confirm the broader rule is acceptable — I believe it is desirable, but it is
a change. If admins must self-approve, this moves to the service layer and weakens.

### D9 — Attendance uniqueness
`attendance_employee_date_unique` is new; Firestore allows unlimited rows per employee per
day. Confirm one row per employee per day is correct — the ETL will fail loudly on existing
duplicates, which is the right way to discover them.

### D10 — Session strategy — ✅ SETTLED
**Short-lived access JWT + a `refresh_tokens` table + a per-request status check.**
Implemented in Phase 1; the table is migration `002_auth_sessions`.

The reasoning worth preserving: neither a stateless JWT nor a refresh table alone gives
*immediate* revocation. A JWT is valid until it expires, and revoking refresh tokens only
stops the next refresh — the access token already issued keeps working. What delivers
immediacy is the per-request principal query **that §6 already mandates**: because it
asserts `users.status = 'active'` and both `deleted_at IS NULL`, deactivation takes effect
on the very next request at no extra cost, since the round trip happens anyway.

The consequence to keep in mind: this forgoes JWT's usual "no database hit" benefit. You
can have immediate revocation or stateless auth, not both. Access tokens therefore carry
**only the subject** — role and department are resolved per request, so a role change also
takes effect immediately rather than at token expiry.

### D11 — Firebase Auth passwords cannot be exported
Password hashes are not retrievable from Firebase Auth in a usable form. Every user must
either reset their password at cutover, or run dual auth during transition. This is a
**user-visible operational event** that needs planning and communication, not just code.

### D12 — Can non-employees take leave?
`canCreateLeave` requires `isEmployee()` (`firestore.rules:421`), so an admin, HR, manager or
TL applying for their own leave is denied today — while the UI offers it to everyone
(ambiguity A10). Should the new API keep that restriction or allow all roles to apply?

### D13 — Deletion authority: managers deleting managers
The decision states a manager may delete "tls and employees within their own department". I
read that as excluding other managers and excluding HR/admin. Confirm. Also confirm admin and
HR retain their current authority unchanged.

### D14 — Row-Level Security
Not proposed. Scope enforcement is service-layer, matching where the callables do it today.
RLS would push it into the database and make a repository bug non-exploitable, at the cost of
per-request `SET LOCAL` on pooled connections. Worth deciding deliberately rather than by
default.

### D15 — Does "required reassignment" extend to department managers?
The decision covers TLs explicitly. I applied the same rule to `departments.manager_employee_id`
(`ON DELETE RESTRICT` rather than `001`'s `SET NULL`) on the grounds that a department without
a manager is the same class of orphan. Confirm, or revert that one to `SET NULL`.

### D16 — Deleting a TL who has no members
The replacement must come from "that tl's own members". A TL with zero members has no
candidate. Options: allow deletion outright (no one to orphan), allow a replacement from
outside the team, or block it. Unhandled today.

### D17 — `employee_number` generation
Firestore derives `empId` as `EMP-<firebaseUid>` (`employeeInvitationService.js:303-305`).
Firebase UIDs disappear. Options: a sequence (`EMP-000123`), the Postgres uuid, or
human-assigned. Existing values must be preserved by the ETL regardless.

### D18 — Triggers for cross-table role invariants
Three rules cannot be `CHECK` constraints because they span tables or rows: *team lead must
have role `tl`*, *only `employee`-role people may have a team lead*, and *leave status
transitions must be `pending → approved|rejected`*. Service layer only, or also enforced by
triggers as defense in depth? Triggers are stronger but add a second place to change.

### D19 — Carried-forward unresolved ambiguities
These were flagged in the earlier documents and the settled decisions do not resolve them:

- **A1** — `kpis.status` permits only `'active'`. `kpi_status` encodes that literally. If KPIs
  should ever be completed or archived, the enum needs more values before any data exists.
- **A3** — `linkLegacyEmployeeUid` has no frontend caller. Does the replacement API need this
  endpoint, or does the ETL make it unnecessary?
- **A5** — payroll `draft` is unreachable today. `payroll_status` retains both values and
  defaults to `'processed'`, preserving current behavior. Should `draft` become reachable?
- **A6** — validators-on-read. Generated columns eliminate this for payroll. It remains a
  question for whether the new API should hide or surface malformed rows.
- **A8** — manager and TL cannot read projects/KPIs through rules, only via
  `getScopedWorkspace`. The new API has no reason to keep that split; §6 gives managers and
  TLs scoped read access directly. **Confirm this is intended** — it is a widening.
- **A10** — client-exposed actions the server denies. Cutover is the natural time to fix the
  UI, but it is frontend work outside this schema.
- **A13** — `.down.sql` is unreachable by `migrator.js`. Should the migrator support down
  migrations, or should the file be deleted as misleading? The rewritten `.down.sql` carries a
  header saying so explicitly, and `backend/test/` asserts it stays symmetric with the up
  migration, so it cannot silently rot while the question is open.

### D20 — `AGENTS.md` §1 still forbids the polling decision
D3 settled on polling, but `AGENTS.md` §1 requires UI behavior to stay unchanged during the
migration, and losing `onSnapshot` changes it. I did not edit `AGENTS.md`: it is the project's
locked rules file, and amending it was not part of this task. Either it should gain an
explicit carve-out for realtime during the migration, or the departure should be recorded as a
knowing exception. **Until then the plan and the rules contradict each other in writing.**

### D21 — `companies_singleton` uses an index on a constant expression
`CREATE UNIQUE INDEX companies_singleton ON companies ((true))` is the idiom specified in
§4.1 and is implemented verbatim. It is the one piece of this migration I could not verify,
because there is no PostgreSQL in this environment. If a real server rejects a constant index
expression, the guaranteed-portable equivalent is a `singleton boolean NOT NULL DEFAULT true`
column with `CHECK (singleton)` and `UNIQUE (singleton)`. **Confirm on first real
`db:migrate`.**
