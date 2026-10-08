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
| `ON DELETE SET NULL` on `departments.manager_employee_id` (`:122`) | `ON DELETE RESTRICT` | the FK itself still tightens, but settled as **not** requiring reassignment the way TLs do — manager_employee_id is auto-cleared to null in the service layer — see [§9 D15](#d15--does-required-reassignment-extend-to-department-managers--settled) |

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
  -- Who soft-deleted the row (D29). Added by migration 009, not 001; ON DELETE SET NULL so
  -- an audit pointer never blocks hard-deleting an employee.
  deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT projects_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT projects_dates_ordered   CHECK (due_date >= start_date),
  CONSTRAINT projects_department_company_foreign_key
    FOREIGN KEY (department_id, company_id) REFERENCES departments (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT projects_team_lead_department_foreign_key
    FOREIGN KEY (team_lead_id, department_id)
    REFERENCES employees (id, department_id) ON DELETE RESTRICT,
  CONSTRAINT projects_scope_unique UNIQUE (id, department_id),
  -- A deleter may only be recorded on a row that is actually deleted (009).
  CONSTRAINT projects_deleted_by_requires_deleted_at
    CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX projects_department_status_index
  ON projects (department_id, status) WHERE deleted_at IS NULL;
CREATE INDEX projects_team_lead_index
  ON projects (team_lead_id) WHERE deleted_at IS NULL;
-- Serves the ON DELETE SET NULL scan above (009).
CREATE INDEX projects_deleted_by_index
  ON projects (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
```

`projects_dates_ordered` replaces `projectMutationService.js:321-329`. The legacy `name`
field — readable but unwritable (`PROTECTED_PROJECT_FIELDS`, `:21-34`) — is **dropped**; the
ETL coalesces `title` then `name`.

`projects` is soft-deleted, and the delete records who did it in `deleted_by_employee_id`; the
block above shows the table as it stands after migration `009`, which added that column, its
`CHECK` and its index to the `001` definition. See the fourth note under
[D1](#d1--soft-or-hard-delete--settled) and [D29](#d29--project-and-kpi-write-rules--settled).

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
  -- Who soft-deleted the row (D29). Added by migration 009, not 001; ON DELETE SET NULL so
  -- an audit pointer never blocks hard-deleting an employee.
  deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,

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
    CHECK (num_nulls(rating, rated_by_employee_id, rated_at) IN (0, 3)),

  -- A deleter may only be recorded on a row that is actually deleted (009).
  CONSTRAINT kpis_deleted_by_requires_deleted_at
    CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX kpis_employee_index ON kpis (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX kpis_project_index  ON kpis (project_id)  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
-- Serves the ON DELETE SET NULL scan above (009).
CREATE INDEX kpis_deleted_by_index
  ON kpis (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
```

**Two of the three preserved bans live here as constraints.** `kpis_no_self_rating` and
`kpis_legacy_not_rateable` are pure row-local predicates, so the database can guarantee them
absolutely — no service bug, no future admin script, and no direct `psql` session can violate
them. That is strictly stronger than `kpiMutationService.js`, where they are `if` statements
in one code path.

`kpis_rating_fields_consistent` has no Firestore equivalent; it prevents the half-rated rows
that `kpiMutationService.js:769-777` avoids only by writing all three fields together.

`kpis` is soft-deleted, and the delete records who did it in `deleted_by_employee_id`; the block
above shows the table as it stands after migration `009`, which added that column, its `CHECK` and
its index to the `001` definition. The API surfaces the three bans as clean errors but does not
re-implement them: see [D29](#d29--project-and-kpi-write-rules--settled) and the fourth note under
[D1](#d1--soft-or-hard-delete--settled).

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
  -- Who soft-deleted the row (D31). Added by migration 010, not 001; ON DELETE SET NULL so
  -- an audit pointer never blocks hard-deleting an employee.
  deleted_by_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,

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
  ),

  -- A deleter may only be recorded on a row that is actually deleted (010).
  CONSTRAINT leaves_deleted_by_requires_deleted_at
    CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX leaves_employee_status_index ON leaves (employee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leaves_date_range_index      ON leaves (start_date, end_date) WHERE deleted_at IS NULL;
-- Serves the ON DELETE SET NULL scan above (010).
CREATE INDEX leaves_deleted_by_index
  ON leaves (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
```

(The `leaves_decision_consistent` shown above is `001`'s; `003` widens it, as the amendment below
describes. `deleted_by_employee_id` and its `CHECK` and index are `010`'s.)

**`days` is a generated column, not a stored value.** `firestore.rules:406-411` requires
`days == (end - start)/86400000 + 1` and rejects the write otherwise. Postgres computes it,
so the field cannot disagree with the dates it derives from. `date - date` yields an integer
day count in Postgres, so the expression is exact and immutable.

> **Superseded in part, 2026-10-07 — not yet migrated.** The expression above counts **calendar**
> days. Management has since decided that leave is counted in **working days**, Saturday and Sunday
> not counting, so this column will need replacing — and, because `Maternity` alone stays in calendar
> days (112), replacing with something that depends on `type`. The migration is not written; see the amendment
> at the end of [D31](#d31--leave-write-rules-and-entitlement--settled) for what that involves and
> what is still undecided.

> **Superseded again, 2026-10-08 ([D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled)).**
> With no limits there is no counting rule to change, so the replacement of this column is **cancelled**.
> The migration was never written, and the calendar-day definition above **stands**.

`decided_by_employee_id` / `decided_at` are **new**. Firestore's `canUpdateLeave`
(`:428-438`) permits changing only `status`, so there is no record of who approved a leave.
Adding it is required to enforce the self-approval ban in the database at all, and is an
audit improvement.

#### Amendment (Phase 2, migration `003_leave_decision_provenance`)

Phase 2's importer surfaced a gap this section didn't anticipate: `leaves_decision_consistent`
as written above requires `decided_by_employee_id` and `decided_at` whenever `status <>
'pending'`, but Firestore's `canUpdateLeave` never recorded either — only `status` itself
changed. Every already-approved or already-rejected leave in Firestore has no approver and
no decision timestamp to import.

Per decision, every leave imports with its real status; `decided_by_employee_id` and
`decided_at` are left `NULL` for pre-cutover decisions rather than fabricated. A new column
and a widened constraint (added by `003`, not by editing this table's original migration)
make that representable without weakening the requirement for anything the live app inserts
going forward:

```sql
ALTER TABLE leaves ADD COLUMN decision_recorded boolean NOT NULL DEFAULT true;

ALTER TABLE leaves DROP CONSTRAINT leaves_decision_consistent;
ALTER TABLE leaves ADD CONSTRAINT leaves_decision_consistent CHECK (
  (status = 'pending' AND decided_by_employee_id IS NULL AND decided_at IS NULL) OR
  (status <> 'pending' AND decision_recorded
     AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL) OR
  (status <> 'pending' AND NOT decision_recorded
     AND decided_by_employee_id IS NULL AND decided_at IS NULL)
);
```

`decision_recorded` names the fact the constraint checks, not when the row arrived — a
future bulk-import feature unrelated to approvers would otherwise be tempted to reuse a
more generic `imported_at` for the same purpose. It defaults to `true`, so every row the
live app ever inserts (Phase 9 onward) keeps the original strict requirement with no
service-layer workaround needed to compensate for a looser database constraint. Only the
Firestore importer ever sets it `false`. `leaves_no_self_approval` needed no change — it
already tolerated a `NULL` approver.

Verified end-to-end against `sigma_hrm_scratch`: an imported approved leave lands with
`decided_by_employee_id NULL`, `decided_at NULL`, `decision_recorded = false`, `status`
preserved as `'approved'`; a *new* row inserted directly with `decision_recorded` left at
its default `true` and no approver is still rejected by the constraint, proving the
relaxation is scoped to imported rows only.

#### Amendment (Phase 9, migration `010_leave_deleted_by_and_usage_view`)

`leaves` is soft-deleted, and the delete records who did it in `deleted_by_employee_id`; the block
above shows the table as it stands after migration `010`, which added that column, its `CHECK` and
its index to the `001` definition. See the fifth note under
[D1](#d1--soft-or-hard-delete--settled) and [D31](#d31--leave-write-rules-and-entitlement--settled).
`010` also replaced the `employee_leave_usage` view, described under [§4.12](#412-leavebalances--dropped).

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
  -- Who soft-deleted the row (D27). Added by migration 007, not 001; ON DELETE SET NULL so
  -- an audit pointer never blocks hard-deleting an employee.
  deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,

  CONSTRAINT attendance_times_ordered
    CHECK (check_in IS NULL OR check_out IS NULL OR check_out > check_in),

  -- absent/leave forces both times empty (firestore.rules:448-496)
  CONSTRAINT attendance_absent_has_no_times
    CHECK (status NOT IN ('absent','leave') OR (check_in IS NULL AND check_out IS NULL)),

  CONSTRAINT attendance_timestamps_ordered CHECK (updated_at >= created_at),

  -- A deleter may only be recorded on a row that is actually deleted (007).
  CONSTRAINT attendance_deleted_by_requires_deleted_at
    CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL)
);

CREATE UNIQUE INDEX attendance_employee_date_unique
  ON attendance (employee_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX attendance_date_index ON attendance (work_date) WHERE deleted_at IS NULL;
-- Serves the ON DELETE SET NULL scan above (007).
CREATE INDEX attendance_deleted_by_index
  ON attendance (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
```

Firestore's `checkIn`/`checkOut` are `HH:MM` strings or `""` (`isValidAttendanceTime`,
`:440-446`). Here they are `time` with `NULL` for absent, so the empty-string sentinel
disappears; the ETL maps `""` → `NULL`.

`attendance_employee_date_unique` is **new** — Firestore permits unlimited duplicate rows for
the same employee and day. See [§9 D9](#d9--attendance-uniqueness--settled).

`attendance` is soft-deleted, and the delete records who did it in `deleted_by_employee_id`;
the block above shows the table as it stands after migration `007`, which added that column,
its `CHECK` and its index to the `001` definition. See the second correction under
[D1](#d1--soft-or-hard-delete--settled) and [D27](#d27--attendance-write-rules--settled).

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
  -- Who soft-deleted the row (D28). Added by migration 008, not 001; ON DELETE SET NULL so
  -- an audit pointer never blocks hard-deleting an employee.
  deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,

  CONSTRAINT payroll_year_range   CHECK (period_year BETWEEN 1 AND 9999),
  CONSTRAINT payroll_month_range  CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT payroll_amounts_non_negative
    CHECK (basic >= 0 AND allowances >= 0 AND bonus >= 0 AND deductions >= 0),

  -- A deleter may only be recorded on a row that is actually deleted (008).
  CONSTRAINT payroll_deleted_by_requires_deleted_at
    CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL)
);

CREATE UNIQUE INDEX payroll_employee_period_unique
  ON payroll (employee_id, period_year, period_month) WHERE deleted_at IS NULL;
-- Serves the ON DELETE SET NULL scan above (008).
CREATE INDEX payroll_deleted_by_index
  ON payroll (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
```

Firestore stores `month` as an **English month name** (`firestore.rules:600-612`); this uses
`period_month integer` so periods sort and range-query correctly. The ETL maps names → 1-12
and the API formats back for display.

**`gross`, `tax` and `net` are generated columns** — see §5 for why.

`payroll` is soft-deleted, and the delete records who did it in `deleted_by_employee_id`; the
block above shows the table as it stands after migration `008`, which added that column, its
`CHECK` and its index to the `001` definition. See the third note under
[D1](#d1--soft-or-hard-delete--settled) and [D28](#d28--payroll-write-rules--settled).

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
company), and `ON DELETE SET NULL` becomes `ON DELETE RESTRICT`. **Correction:** this does
not mirror the TL rule the way it first appears to — `departments` is soft-deleted in practice
(see the correction after D1), so this FK is inert on the real deletion path, exactly as
`employees_team_lead_department_foreign_key` is. D15 settled the actual behavior as auto-
clearing `manager_employee_id` to null in the service layer, not requiring a replacement. See
[§9 D15](#d15--does-required-reassignment-extend-to-department-managers--settled).

### 4.12 `leaveBalances` — dropped

Per decision, balances are computed. A view replaces the collection:

```sql
CREATE VIEW employee_leave_usage AS
SELECT leaves.employee_id,
       leaves.type,
       date_part('year', leave_dates.leave_date)::int  AS usage_year,
       date_part('month', leave_dates.leave_date)::int AS usage_month,
       (count(*) FILTER (WHERE leaves.status = 'approved'))::int AS days_approved,
       (count(*) FILTER (WHERE leaves.status = 'pending'))::int  AS days_pending
FROM leaves
CROSS JOIN LATERAL generate_series(
  leaves.start_date::timestamp, leaves.end_date::timestamp, interval '1 day'
) AS leave_dates(leave_date)
WHERE leaves.status IN ('approved', 'pending') AND leaves.deleted_at IS NULL
GROUP BY 1, 2, 3, 4;
```

This is the view as it stands after migration `010`, which replaced `001`'s. The original
grouped by *year and type* and attributed a whole leave to its start year; it could not express
management's entitlement ([§9 D4](#d4--where-do-leave-entitlements-come-from)): a monthly pool that
resets, a December bonus, and a yearly pool shared by two types. This one splits every leave **per
calendar day** and charges each day to the month it falls in (D5), so a leave from 30 January to
2 February is 2 days of January and 2 of February.

It is deliberately a pure **usage** fact. It knows nothing of pools, allowances, or which leave
type draws on which pool: the type-to-pool map and the entitlement numbers live in one code
module, `src/services/leaveEntitlements.js`, so a change to management's rules is a change to that
module and not a view rewrite. Only approved and pending leaves count (a pending request reserves
its days) and rejected and soft-deleted ones never do; the two statuses are separate columns so a
caller can show them apart. The balance itself — entitlement minus usage — is computed from this view
and that module, and served at `GET /api/v1/leave-balances`; see
[D31](#d31--leave-write-rules-and-entitlement--settled). The old view's columns (`leave_year`,
`days_used`) are gone; nothing in the code base read them.

> **Superseded in part, 2026-10-07 — not yet migrated.** This view splits a leave per **calendar**
> day, weekends included. Management has since decided that leave counts in **working days**, so the
> per-month split needs the same treatment as the `days` column in §4.8, including counting
> `Maternity` in calendar days. (A fourth, Eid, pool needs no change to this view: type decides every
> pool, so Eid leave would need a leave type of its own — see D31's second amendment.) The migration is not written; see the amendment at
> the end of [D31](#d31--leave-write-rules-and-entitlement--settled).

> **Superseded again, 2026-10-08 ([D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled)).**
> The per-month, per-day split was built for the pool model, which no longer exists, so it is no longer
> needed. **This view is now an open question**: reuse it as the basis of a "days taken" figure, change
> it, or drop it. Any of those is a **new migration** (`001`–`010` are never edited), and none is
> written. Until then the view exists in the schema, and migration `010`'s tests still describe it
> accurately, because `010` itself does not change.

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

**Edge case, settled:** a TL with zero members has no possible replacement, so the flow above
does not run at all in that case — deletion proceeds outright instead. See
[§9 D16](#d16--deleting-a-tl-who-has-no-members--settled).

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

> **Correction:** despite the "hard delete everywhere else" sentence above, `departments` is
> actually wired up as soft-delete in practice — it has a `deleted_at` column,
> `departments_name_unique` is a partial index on `deleted_at IS NULL`, and
> `departmentRepository.js` filters every query on `deleted_at IS NULL`. That sentence is
> stale for this one table; do not trust it. The same "`ON DELETE RESTRICT` does not fire on
> a soft delete" point made above applies equally to both of `departments`'s own foreign
> keys — see [D15](#d15--does-required-reassignment-extend-to-department-managers--settled)
> and [D26](#d26--deleting-a-department-that-still-has-employees-in-it--settled), both of
> which are service-layer obligations for exactly this reason, not database guarantees.

> **Second correction:** `attendance` is likewise soft-deleted in practice, exactly as
> `departments` is. It has a `deleted_at` column, `attendance_employee_date_unique` is a
> partial index on `deleted_at IS NULL`, and `attendanceRepository.js` filters every query on
> `attendance.deleted_at IS NULL`, so "hard delete everywhere else" is stale for this table
> too. The "`ON DELETE RESTRICT` does not fire on a soft delete" point applies to
> `attendance.employee_id` as well. The delete path also records *who* deleted the row — see
> [D27](#d27--attendance-write-rules--settled).

> **Third note (payroll):** unlike `departments` and `attendance`, `payroll` needed no
> correction: D1's "soft delete for `payroll`" is accurate. It has a `deleted_at` column,
> `payroll_employee_period_unique` is a partial index on `deleted_at IS NULL`, and
> `payrollRepository.js` filters every query on `payroll.deleted_at IS NULL`. What it lacked
> was a record of who deleted a row — added by D28 — and §8 item 5 (statutory retention) is
> closed by the same decision: no hard-delete path will exist. See
> [D28](#d28--payroll-write-rules--settled).

> **Fourth note (projects and KPIs):** `projects` and `kpis` are soft-deleted in practice, so
> "hard delete everywhere else" is stale for them too. Both have a `deleted_at` column and
> partial indexes on `deleted_at IS NULL`, and `projectRepository.js` and `kpiRepository.js`
> filter every query on it. `project_assignments` is the exception that D1's text got right: it
> has no `deleted_at` and stays a hard-deleted join table. Because both parent tables are
> soft-deleted, their `ON DELETE RESTRICT` foreign keys (`kpis.project_id`, the project's
> team lead, an assignment's employee) are inert on the real deletion path, and
> `project_assignments`' `ON DELETE CASCADE` on the project side never fires — so what those
> constraints appear to guarantee is a service-layer obligation here, exactly as for
> departments (D26). Both deletes record who did it. See
> [D29](#d29--project-and-kpi-write-rules--settled).

> **Fifth note (leaves):** like `payroll`, `leaves` needed no soft/hard correction: D1's "soft
> delete for `leaves`" is accurate. It has a `deleted_at` column, its indexes are partial on
> `deleted_at IS NULL`, and both `employee_leave_usage` and `leaveRepository.js` filter on it.
> Two things were missing. Firestore never allowed *any* delete of a leave
> (`allow delete: if false`), so a mistaken request could only ever be rejected; and there is
> no record of who deleted a row. [D31](#d31--leave-write-rules-and-entitlement--settled) adds the
> deleter and settles who may delete, which also answers §8 item 7 (a deleted leave never counts
> against a balance).

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

**✅ SETTLED (Phase 9) — management's entitlement rules.** As relayed by the project owner on
2026-10-07, and recorded here as given:
- Every employee gets **2 leaves per month**. They do **not** carry forward: each month starts
  fresh at 2.
- Separately, the company grants **10 leaves in December** as a year-end (Christmas) benefit, **on
  top of** the monthly 2. An employee who joined mid-year still gets them.
- Separately again, **14 leaves per year** are available for Hajj, Umrah, illness or similar
  serious need. They are granted **annually, not once in a lifetime**, and are **not gated behind
  strict proof**.

So entitlement is a global rule, not per role or per employee, and these three pools replace the
mock values in `src/data/leaveBalance.js` (Annual 15, Sick 10, Casual 5), which are superseded.
How the pools map onto the five leave types, and how a balance is computed from them, is
[D31](#d31--leave-write-rules-and-entitlement--settled). (This heading keeps its original text so
the existing links to it from `migration-plan.md` still resolve.)

> **Amended 2026-10-07:** "these three pools" is no longer the whole picture. Management has since
> added a **fourth pool** (2 days per Eid) and made leave count in **working days**. The three
> rules above stand as recorded; see the amendment at the end of
> [D31](#d31--leave-write-rules-and-entitlement--settled).

> **SUPERSEDED 2026-10-08 by [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled):
> the answer to D4 is now that there are no leave entitlements.** The three rules above, and the fourth
> pool noted in the amendment, were management's position on 2026-10-07. They are kept as recorded,
> because the reasoning is worth having if limits are ever reintroduced, but none of them is in force.

### D5 — Does an approved leave in a prior year still count?
`employee_leave_usage` groups by `date_part('year', start_date)`. A leave spanning a year
boundary is attributed entirely to its start year. Confirm, or specify proration.

**✅ SETTLED (Phase 9) — split by calendar day, not attributed to the start.** With a pool that
resets every month, attributing a whole leave to its start would be wrong in both directions: a
four-day leave from 30 January to 2 February would charge all four days to January's 2. A leave is
therefore split **per calendar day across the months it covers**, each day charged to the month it
falls in, and to the calendar year it falls in for the 14-per-year pool. This replaces the view's
start-year attribution. See [D31](#d31--leave-write-rules-and-entitlement--settled). (This heading
keeps its original text so the existing links to it still resolve.)

> **Amended 2026-10-07:** the leave is still split per day across months, but **only working days
> are charged** now (Saturday and Sunday are not). The example above depends on the year: in 2026,
> when 30 January is a Friday, 30 January to 2 February is 1 working day of January and 1 of
> February, not 2 and 2. See the amendment at the end of
> [D31](#d31--leave-write-rules-and-entitlement--settled).

> **SUPERSEDED 2026-10-08 by [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled).**
> With no pools there is no month or year to charge a day to, so the per-day split has no purpose.
> Whether a "days taken" figure splits a leave across periods or attributes it whole is an open question
> in D40.

### D6 — `role` on `users` rather than `employees`
Firestore keeps role on the employee document. I put it on `users` (§4.2 rationale). Confirm.
Reversing this later means moving a column every authorization path reads.

### D7 — Generated `tax` and `net` remove manual override forever
Making them generated columns means no one can ever record a manually adjusted tax figure —
not through the API, not through `psql`. That exactly matches Firestore's behavior today.
Confirm no payroll correction workflow needs an override. If one does, `tax` must become a
plain column with a `CHECK`, which is weaker.

**✅ SETTLED (Phase 7).** `tax` and `net` stay generated, and no override is ever added. The
correction workflow is not an override: a processed record is immutable, so correcting one means
soft-deleting it and processing a new one for the period, which the partial
`payroll_employee_period_unique` index permits. See
[D28](#d28--payroll-write-rules--settled). (This heading keeps its original text so the
existing link to it from `migration-plan.md` still resolves.)

### D8 — Self-approval ban is broader than Firestore's
Firestore bans self-approval **only for TLs** (`firestore.rules:358`); admin, HR and managers
are not blocked. `leaves_no_self_approval` blocks everyone, because a `CHECK` cannot see the
approver's role. Confirm the broader rule is acceptable — I believe it is desirable, but it is
a change. If admins must self-approve, this moves to the service layer and weakens.

**✅ SETTLED (Phase 9) — the broader rule stands.** No role may decide its own request:
`leaves_no_self_approval` stays a database constraint covering everyone. This matters now that every
role may apply (D12): an admin's, hr's or manager's own request has to be decided by someone else. The
consequence to keep in view is that an **admin's request needs another admin or an hr** to approve it,
so an organisation with a single admin and no hr cannot get that admin's leave approved. See
[D31](#d31--leave-write-rules-and-entitlement--settled).

### D9 — Attendance uniqueness — ✅ SETTLED
`attendance_employee_date_unique` is new; Firestore allows unlimited rows per employee per
day. Confirm one row per employee per day is correct — the ETL will fail loudly on existing
duplicates, which is the right way to discover them.

**Settled: one row per employee per day, rejected rather than merged.** `POST` of a second
record for an employee and day that already has a live one returns
`409 attendance_already_recorded`, and the error carries the existing record's id so the
caller can `PATCH` it instead. A `PATCH` that moves a record onto an occupied employee and day
gets the same 409 (mapped from `23505` on `attendance_employee_date_unique`). Rejected
alternatives: upsert-on-`POST` (silently overwrites, hides accidental double-marks, blurs
create versus correct) and several rows per day (contradicts the index and would need a
migration). Because the index is partial on `deleted_at IS NULL`, a soft-deleted record does
not block re-marking that day. See [D27](#d27--attendance-write-rules--settled).

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

**✅ SETTLED (Phase 9) — every role may apply, for themselves only.** "Every employee gets 2 leaves
per month" is read as every person in the `employees` table, whatever their role. Nobody applies for
someone else, and the request's employee is never client-supplied. The frontend currently shows the
Apply button only to employee-role users, so the API is broader than the UI until the frontend adds it
for the other roles. See [D31](#d31--leave-write-rules-and-entitlement--settled).

### D13 — Deletion authority: managers deleting managers
The decision states a manager may delete "tls and employees within their own department". I
read that as excluding other managers and excluding HR/admin. Confirm. Also confirm admin and
HR retain their current authority unchanged.

### D14 — Row-Level Security
Not proposed. Scope enforcement is service-layer, matching where the callables do it today.
RLS would push it into the database and make a repository bug non-exploitable, at the cost of
per-request `SET LOCAL` on pooled connections. Worth deciding deliberately rather than by
default.

### D15 — Does "required reassignment" extend to department managers? — ✅ SETTLED
The decision covers TLs explicitly. I applied the same rule to `departments.manager_employee_id`
(`ON DELETE RESTRICT` rather than `001`'s `SET NULL`) on the grounds that a department without
a manager is the same class of orphan. Confirm, or revert that one to `SET NULL`.

**Settled: it is not the same class of orphan, and the TL analogy does not hold.** A dangling
`team_lead_id` breaks *another employee's own* scope and visibility —
`employeeScopeService.js`'s team predicate depends on it pointing at a real team lead. A
department with no manager breaks nothing downstream: department-scoped authorization keys
off `department_id` alone, never off `manager_employee_id`. Forcing reassignment ceremony
here would defend against a risk that isn't structurally present.

When a department's manager is removed — the employee is deleted
(`employeeMutationService.deleteEmployee`), or a department update clears
`manager_employee_id` directly — `manager_employee_id` is simply cleared to `null` in the
service layer, no replacement required. This is the practical equivalent of reverting the FK
to `ON DELETE SET NULL`, the alternative this entry itself originally offered, except
enforced in application code rather than left to the database: `departments` is soft-deleted
in practice (see the correction after D1), so `departments_manager_employee_foreign_key`'s
`ON DELETE RESTRICT` never actually fires on the real deletion path, exactly as it doesn't
for employees' own foreign keys. Reassigning a new manager afterward is an ordinary, unforced
`PATCH /api/v1/departments/:id` — not a blocking requirement.

### D16 — Deleting a TL who has no members — ✅ SETTLED
The replacement must come from "that tl's own members". A TL with zero members has no
candidate. Options were: allow deletion outright (no one to orphan), allow a replacement
from outside the team, or block it.

**Settled: allow deletion outright.** With zero members there is nobody to orphan and
nobody to promote, so the entire premise of the replacement flow (§6.1) does not apply —
requiring a `replacementTeamLeadId` here would demand a value that can never be validated
against anything, and blocking the delete would leave an empty team lead permanently
undeletable for no protective reason. `assertCanDeleteEmployee`
(`backend/src/services/employeeAuthorizationService.js`) returns `{ replacementTeamLeadId:
null, reassignedMemberIds: [] }` immediately once the live member list is empty; a
`replacementTeamLeadId` supplied anyway is simply ignored rather than validated, since
there is no member list to validate it against.

### D17 — `employee_number` generation — ✅ SETTLED
Firestore derives `empId` as `EMP-<firebaseUid>` (`employeeInvitationService.js:303-305`).
Firebase UIDs disappear. Options: a sequence (`EMP-000123`), the Postgres uuid, or
human-assigned. Existing values must be preserved by the ETL regardless.

Settled on a Postgres sequence, implemented by migration
`005_employee_number_sequence`: `EMP-` followed by the sequence value, zero-padded to a
*minimum* of 4 digits (`EMP-0001`, `EMP-9999`, `EMP-10000` — never truncated past whatever
digits the sequence actually produced, only ever padded up). Not `max(employee_number)+1`:
`employees_number_unique` (001) is a partial index on `deleted_at IS NULL`, so computing the
next number from live rows would reissue a soft-deleted employee's number to a new hire, and
two employees created at once could compute the same next value. A sequence never goes
backwards and is race-free. Every employee-creating caller — the Phase 4 bootstrap script,
and later employee-create — draws from the same sequence via `SELECT
next_employee_number()`.

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
  **Resolved:** yes — see [D28](#d28--payroll-write-rules--settled).
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

### D21 — `companies_singleton` uses an index on a constant expression — ✅ VERIFIED
`CREATE UNIQUE INDEX companies_singleton ON companies ((true))` is the idiom specified in
§4.1 and is implemented verbatim. Verified against a real PostgreSQL 17 server during Phase
0/1 scratch-database checks: the index is accepted and does enforce the singleton (a second
insert fails with a unique-violation on `companies_singleton`). No fallback needed.

### D22 — Leave decision provenance — ✅ SETTLED
`decision_recorded` on `leaves`, added by migration `003_leave_decision_provenance`. See
§4.8's Amendment above for the full reasoning; recorded here per the numbering convention.
Verified end-to-end against `sigma_hrm_scratch` in Phase 2.

### D23 — `firestore_import_refs` bookkeeping table
Migration `004_firestore_import_bookkeeping` adds a table scoped to the importer alone —
`(source_collection, source_id) -> target_id`, the same role `schema_migrations` plays for
the migrator. It exists because `projects` and `kpis` have no natural key at all (every
other imported table already has one: `companies` singleton, `departments` name, `users`
email, `employees` user_id, `attendance` employee+date, `payroll` employee+period), so a
second import run would otherwise insert duplicate `projects`/`kpis` rows with no way to
recognize "this Firestore document was already imported." Does not add any column to
`projects` or `kpis` themselves and does not touch this document's table definitions for
them. Verified idempotent end-to-end: re-running the importer against an unchanged dataset
produced zero new rows anywhere, and the previously-imported project/KPI/leave rows kept
their exact same ids across both runs.

### D24 — Department manager must work in the department they manage — ✅ FOUND AND FIXED
Found during Phase 2's real-server verification, not by inspection. The importer's
`planDepartmentManagers` originally only checked that a department's `managerId` resolved
to *some* employee — not that the employee's own department matched the department being
managed. `departments_manager_employee_foreign_key` is composite —
`(manager_employee_id, id) -> employees(id, department_id)` — precisely to require that a
department's manager work in that department (§4.11), so a manager assigned to a different
department reached Postgres as an uncaught foreign-key violation during `--apply` instead of
a clean, categorized conflict at plan time. Fixed by adding a
`department-manager-wrong-department` conflict check before the write is attempted, mirroring
the pattern already used for every other cross-reference check in the importer. This was a
gap in the importer's validation, not in the schema — the schema's own constraint caught the
bad data correctly; the importer just didn't catch it first.

### D25 — Set-password token delivery for invited employees — ✅ SETTLED (interim)

Employee-create (Phase 4 Part B) leaves `users.status = 'invited'` with no `password_hash` —
there was no way for that account to ever become usable. Phase 4 Part C closes that gap with
a single-use, expiring token: migration `006_password_set_tokens` adds a dedicated
`password_set_tokens` table (`user_id`, `token_hash`, `expires_at`, `used_at`, `revoked_at`),
hashed with SHA-256 exactly the way `refresh_tokens` is, for the same reason — a high-entropy
random value isn't brute-forceable the way a password is, so a fast digest is enough and
keeps redemption a single indexed lookup.

**Deliberately not `refresh_tokens`.** A different lifecycle (single-use, never rotated,
revoked wholesale on reissue rather than individually) and a different audience (an
unauthenticated person redeeming an invite, not an already-logged-in session). Folding it
into `refresh_tokens` would have meant a table whose columns mean two different things
depending on which kind of row you're looking at.

**How the token reaches the employee: it is returned in the API response to the admin/hr who
issues it, and nowhere else.** There is no email-sending infrastructure in this system, and
no frontend route yet that could meaningfully receive a link (the React app does not call
this API at all — `migration-plan.md`; `AGENTS.md` §1 keeps frontend behavior frozen during
the migration). Returning the bare token to an already-authenticated admin/hr, for them to
relay out of band (Slack, a phone call, an offer letter), is the only option that doesn't
assume delivery infrastructure that doesn't exist. It is shown exactly once, at issuance;
losing it before relaying it means issuing a new one, not retrieving the old one.

**One live token per user.** Issuing a new token revokes any still-outstanding one for that
user first, in the same transaction — mirrors how login already rotates refresh tokens
rather than letting old ones accumulate, and means a lost-then-reissued token can't be
resurrected later by whoever it was leaked to.

**TTL: 24 hours**, `PASSWORD_SET_TOKEN_TTL_SECONDS` (default `86400`, same override pattern
as the access/refresh TTLs in `config/env.js`). Long enough for a human to relay it out of
band, short enough that a token sitting in a chat message or on a printed sheet isn't a
standing risk.

**Redemption**, all in one transaction: sets `password_hash` and flips `users.status` to
`'active'`, marks the token used, and **revokes every outstanding refresh token for that
user** — if an invited account somehow already had a live session, setting a password ends
it rather than leaving it running alongside the new credential. An unknown, expired, or
already-used token all produce the identical generic error; the endpoint never confirms
whether a token exists, matching how login already never reveals whether an email is
registered.

**Issuance is admin/hr only — not "whoever may update this employee."** A manager or tl can
edit an employee's phone number under Phase 4 Part B's authorization rules, but minting a
working login credential is a materially larger power, and nothing in `auth-matrix.md`
grants it to either role. Enforced in `passwordSetService`, independently of
`employeeAuthorizationService`'s update/delete gates.

**This is explicitly an interim mechanism, not a design to build on.** It exists because
there is currently no email infrastructure and no frontend route to hand a link to. Once
either exists, the right shape is almost certainly a link (not a bare token read off an API
response) delivered by an actual email send, and this decision should be revisited rather
than assumed permanent. A future reader finding this code should not conclude that returning
raw credentials in API responses is this codebase's general pattern — it is a deliberate,
narrow exception made for exactly one flow, for exactly this reason.

> **Revisit opened (2026-10-07):** reading the frontend for its cutover showed it is built around
> an emailed link (`sendEmployeePasswordSetupEmail`, a "Resend" button) and has no route to
> receive a token. This decision stands unchanged; how the frontend should handle it is open as
> [D34](#d34--delivering-the-password-setup-link-builds-on-d25).

### D26 — Deleting a department that still has employees in it — ✅ SETTLED

`employees.department_id` is `NOT NULL`, so a department cannot be deleted out from under its
own staff. Unlike D16's team-lead case there is no "zero employees, nothing to orphan" escape
hatch — a department either has employees or it doesn't, and if it does, something must
happen to them first.

**Settled: block outright, no bulk reassignment.** `DELETE /api/v1/departments/:id` refuses
with `409 department_has_employees` if any live (`deleted_at IS NULL`) employee has that
`department_id` — and the error reports *how many* are blocking it, so the caller knows what
they are dealing with rather than being told only that the delete failed. Moving people out
is done individually, via the already-built `PATCH /api/v1/employees/:id` (`department_id`
change, Phase 4 Part B) — no new bulk-move logic is introduced for this.

A bulk-reassignment option was considered and deliberately rejected: `DELETE` accepting a
target department and moving every remaining employee into it in one transaction. Moving an
arbitrary, potentially large set of unrelated people is a materially bigger and riskier piece
of transactional logic than anything this reassignment problem has needed so far — the
TL-replacement flow (§6.1) only ever moves a bounded, already-known set (one TL's own direct
reports). A department merge/bulk-move tool deserves to be its own deliberately-designed
feature if it is ever actually needed, not a side effect of a delete endpoint.

Like D15, this is a service-layer obligation, not a database guarantee:
`employees_department_company_foreign_key`'s `ON DELETE RESTRICT` would block a hard delete,
but `departments` is soft-deleted in practice (see the correction after D1), so the live-
employee count check above is the only thing actually preventing a department from vanishing
while its employees still silently point at it.

### D27 — Attendance write rules — ✅ SETTLED

Decided before Phase 6 implementation. Everything here is a service-layer or API-layer rule
unless it says otherwise; §5 is the authority for why the temporal checks are not `CHECK`
constraints.

**Who may write.** Create, update and delete: `admin` and `hr` for any employee; `manager`
only for employees in their own department (themselves included); `tl` and `employee` are
denied. This matches `firestore.rules` (`canManageCanonicalEmployeeRecord`) and the auth
matrix. The premise that Firestore let employees write their own attendance was wrong: no
role outside that set ever could, and the frontend already hides Mark/Edit/Delete from them.
Letting TLs write for their team, or employees self-record check-in/out, was considered and
is out of scope — employee self-service would be a new feature (self-attested times, a
different endpoint shape, a status subset) and gets its own design.

**Delete is soft, and records the deleter.** Delete sets `deleted_at` and a new
`deleted_by_employee_id`; see the second correction after D1. Attendance feeds payroll, so "a
record vanished and nobody knows who removed it" is a real gap, not a cosmetic one. This needs
a **new migration `007`** (never an edit to `001`–`006`), written at implementation time. Two
design points are left to that migration rather than settled here: the FK to `employees(id)`
should be `ON DELETE SET NULL` (a `RESTRICT` audit pointer would block ever hard-deleting an
employee), and a `CHECK` should require `deleted_at IS NOT NULL` whenever
`deleted_by_employee_id` is set.

**Future dates use a configured company timezone.** `work_date` must be on or before today in
a configured IANA timezone, evaluated against an injectable clock so the service tests do not
depend on wall time. UTC (Firestore's `request.time.date()`) was rejected: for a UTC+5
workforce it would reject marking today's attendance between 00:00 and 05:00 local. The check
lives in the service layer, per §5.
The company timezone is **`Asia/Karachi`**, supplied through the required environment variable
`COMPANY_TIMEZONE`. It is validated as an IANA name at startup and has **no default**: a
missing or misspelled value must fail startup loudly rather than fall back silently to
something wrong. `Asia/Karachi` is a deployment setting, not a code constant, and
`.env.example` carries only a placeholder (added at implementation time). Nothing in the
backend has a timezone setting today.

**Re-attribution is scope-checked on both sides.** `PATCH` may change `employee_id` (Firestore
parity), but the scope check must pass for the employee the record is moving **from** (the
stored record's current `employee_id`) *and* the employee it is moving **to**, and it runs
before anything is written. Checking only the destination would let a manager pull a record
out of another department into their own and end up holding a record they were never allowed
to touch. `admin` and `hr` pass trivially (company-wide). A `work_date` change stays subject to
D9's uniqueness.

**The `created_at` / `updated_at` "is today" checks are dropped.** Firestore's
`createdAt == updatedAt`, `createdAt` is today and `updatedAt` is today checks existed because
the client authored timestamps. Here the request schema is strict (client-supplied timestamps
are rejected) and `now()` plus the `set_updated_at()` trigger set them, so the conditions hold
by construction. This supersedes the "`updated_at` bounds" wording in the Phase 6 plan and
fills the missing create-side row in §5.

**Accepted defaults.** These were put forward with a recommendation and explicitly accepted:
- *No edit window.* Permitted writers may edit or delete past records (Firestore parity). A
  lock on closed periods belongs to a payroll-period mechanism, not to attendance.
- *Active-employee requirement is narrower than Firestore's.* The referenced employee must have
  `employment_status = 'active'` on create and when `employee_id` changes, but not on every
  update, so a deactivated employee's historical records stay correctable. As an enum, the
  status removes the trim/lowercase split-brain described in §5.2.
- *Wire format.* Times are `HH:MM` or `null` (no `""` sentinel); `notes` is nullable.

### D28 — Payroll write rules — ✅ SETTLED

Decided before Phase 7 implementation. Everything here is a service-layer or API-layer rule
unless it says otherwise; `gross`, `tax` and `net` remain generated columns (§5, D7), so the
service never does payroll arithmetic.

**Who may write.** Create, edit and delete: `admin` and `hr`, for any employee. `manager`, `tl`
and `employee` are denied; an employee keeps read-only access to their own `processed` rows
(unchanged from Phase 3). This matches `firestore.rules`, the auth matrix, Phase 7's own text and
the frontend's `managePayroll`. As for attendance, an account not linked to an employee record is
denied, because the acting employee's id is recorded as the deleter. Admin and hr may process
payroll for their own employee record, as Firestore allowed. Admin-only, and widening to managers,
were considered and rejected: neither has a source behind it.

**Status lifecycle — resolves A5.** `POST` accepts `status` (`draft` or `processed`), defaulting
to `processed`, so today's behavior is the default. A `draft` is fully editable — employee,
period, `basic`, `allowances`, `bonus`, `deductions` — and can be promoted to `processed`, alone or
in the same request as field edits, validated as the merged record. A `processed` record is
**immutable**, exactly as in Firestore, and `processed` → `draft` is refused. A `PATCH` of a
processed record is refused with a conflict error. Employees never see drafts
(`buildPayrollScopeFilter`, unchanged). Consequences accepted: a corrected payslip has a new id,
and an off-cycle bonus means soft-deleting and re-processing the period's single row. Strict
parity (a `PATCH` that only promotes imported drafts) was rejected because it would build an
endpoint no client can reach; making processed records editable was rejected because there is no
history table, so an edit would silently change a payslip an employee may already have seen.

**Duplicate employee and period — mirrors D9.** The unique index
`payroll_employee_period_unique` is new; Firestore allowed unlimited rows and the frontend never
checked. A second live record for the same employee and period returns
`409 payroll_already_recorded` carrying the existing record's id. A draft `PATCH` that moves it
onto an occupied period gets the same 409 (mapped from `23505` on that index). A soft-deleted row
does not block re-processing, because the index is partial. Rejected: upsert on `POST` (it would
silently overwrite a processed payslip) and several rows per period (it contradicts the index and
the importer's `duplicate-payroll-period` conflict).

**Delete is soft, for any status, and records the deleter.** Delete sets `deleted_at` and a new
`deleted_by_employee_id`; see the third note after D1. There is no hard-delete path, which closes
§8 item 5. Because processed records are immutable, soft delete is also the only correction path,
which is what settles D7. This needs a **new migration `008`** (never an edit to `001`–`007`),
written at implementation time. As for `007`, the design points are left to the migration: the FK
to `employees(id)` should be `ON DELETE SET NULL`, a `CHECK` should require `deleted_at IS NOT
NULL` whenever the deleter is set, and a partial index should serve the `SET NULL` scan. Rejected:
drafts-only soft delete (a mistaken processed row could never be removed, leaving no correction
path) and hard delete.

**Pay inputs.** `basic` and `allowances` default to the employee's *current* values when omitted;
explicit values are accepted, which is what backdated periods, raises and corrections need.
`bonus` and `deductions` default to `0`. `gross`, `tax` and `net` are never accepted from the
client; the strict schema refuses them. Only admin and hr can write payroll and the same roles
can change an employee's compensation, so defaulting and overriding open no privilege gap.
Amounts with more than two decimal places, or beyond `numeric(12,2)`'s range, are rejected with a
400 rather than being silently rounded or overflowing in the database.

**Which employees.** The referenced employee must be live (`deleted_at IS NULL`). Their
`employment_status` is **not** checked, so final pay for an employee who is terminated, inactive
or on leave still works — Firestore only required the employee to exist, and this is deliberately
unlike attendance's active requirement (D27). It applies on create and when a draft's
`employee_id` changes.

**Periods.** `period_month` is an integer 1–12 on the wire (Firestore's English month names are
an ETL concern only). There is no temporal check beyond the existing year 1–9999 and month 1–12
`CHECK`s: future periods are not rejected, as Firestore did not.

**Serialization.** Payroll's shared column list selects the money columns (`basic`, `allowances`,
`bonus`, `deductions`, `gross`, `tax`, `net`) as `float8`, so reads and write responses carry JSON
numbers. `pg` returns `numeric` as a string, and the frontend adds these values
(`p.basic + p.allowances + p.bonus`), which would concatenate; `parityService.js` compares with
`Number(a) === Number(b)`, which is why the harness never showed it. `numeric(12,2)` has at most
12 significant digits, which a double holds exactly. This is payroll-only: the same string
behavior on `employees.basic` and `employees.allowances` is a known, separate fix.

### D29 — Project and KPI write rules — ✅ SETTLED

Decided before Phase 8 implementation. This replaces `manageProject` and `manageKpi`; the
`getScopedWorkspace` read callable is already replaced by Phase 3's scoped reads. Everything here
is a service-layer or API-layer rule unless it says otherwise. The three KPI bans — self-rating,
legacy-KPI rating, and rating fields moving together — are database constraints (§4.7) and are
**not** re-implemented in the service; the API only surfaces their violations as clean errors.

**Who may write — the callables' policy, carried over.** The auth matrix's "denied" rows for
`projects` and `kpis` describe the *rules* layer: client writes are blocked there because the
callables write through the Admin SDK. The effective policy is `MANAGING_ROLES = {admin, hr,
manager, tl}` in `projectMutationService.js` and `kpiMutationService.js`, each with scope, and that
is what carries over. `getScopedWorkspace` was read-only and says nothing about writes.

- `admin` and `hr`: any project and any KPI.
- `manager`: a project whose department is their own, and the *resulting* project's department must
  also be their own; a KPI whose project **and** employee are both in their department.
- `tl`: an existing project in their department that they lead or that has any assignee who reports
  to them. The *resulting* project — on create and on edit — must have them as its lead, be in their
  department, and have **every** assignee on their team. A KPI needs the project in that scope and the
  employee on their team.
- `employee`: denied.

Scope is checked against the existing project and against the resulting one, so a TL can manage a
project they only partly touch but can never leave one that is not wholly theirs. This write scope is
deliberately narrower than Phase 3's read scope (a TL reads KPIs of their members and themselves
through the employee join; a manager reads every KPI in their department), so it needs its own
write-scope predicate rather than reusing the read filters. That is intentional, not drift.

**Assignments are managed through the project endpoints.** `assigned_employee_ids` is required, with
at least one, on `POST /api/v1/projects`, and when supplied on `PATCH` it replaces the whole set
atomically in one transaction. No duplicates. Each assignee must be an active `employee`-role person in
the project's department (the database already forces the same department, through the composite
foreign keys); a team lead must be an active `tl` in the same department. Separate assignment
endpoints were rejected: "at least one assignee" would become a cross-request rule, and the
frontend's single project form would have to change. A project's own department, lead and assignees
stay editable under the two-sided scope check above.

**A KPI's employee and project are frozen.** `PATCH /api/v1/kpis/:id` rejects `employee_id` and
`project_id`, as `kpiMutationService.js` always did (both are protected fields); correcting an
attribution is delete and re-create. A rating belongs to one employee on one project, so moving a KPI
would transplant someone's evaluation. A two-sided re-attribution rule, as in D27, was considered and
rejected for that reason.

**Creating a KPI.** A project is required, so no new legacy (project-less) KPIs; legacy rows can only
come from the import and can still be edited and deleted, but never rated. The KPI's employee must be
active, `employee`-role, in the project's department and an assignee of it. That eligibility is
checked at **create only**: later edits and ratings rely on scope and on the database. This departs
from `kpiMutationService.js`, which re-verified it on every write and thereby left a KPI un-editable
and un-deletable once its employee was unassigned or changed role. `status` stays `active` only (A1
remains open).

**Rating is its own operation: `POST /api/v1/kpis/:id/rating`.** The body is `{rating}` alone, an
integer 1–10. The server sets `rated_by_employee_id` and `rated_at` — a client never says who rated or
when. It is never combined with other fields. Re-rating overwrites and replaces the rater and time
(there is no rating history); clearing a rating is refused. Project KPIs only. Who may rate is the
KPI write scope above. The constraint violations surface as clean errors: self-rating as `403
self_rating_denied`, a legacy KPI as `409 legacy_kpi_not_rateable`, an out-of-range value as `400`.
`POST` was chosen over `PUT` so the CORS method list does not change. Because eligibility is checked
at create only, self-rating is reachable through the API only after the employee's role has changed —
a manager who was once an assigned employee — and the database then refuses it. That is how the
"must fail at the database" check is exercised end to end.

**Delete is soft, and records the deleter, for both.** `projects` and `kpis` each get
`deleted_by_employee_id` alongside the existing `deleted_at`; see the fourth note after D1. This
needs a **new migration `009`** (never an edit to `001`–`008`), written at implementation time, adding
the column to both tables. As for `007` and `008`, the design points are left to the migration: the FK
to `employees(id)` should be `ON DELETE SET NULL`, a `CHECK` should require `deleted_at IS NOT NULL`
whenever the deleter is set, and a partial index should serve the `SET NULL` scan. `project_assignments`
is untouched: its rows are hard-deleted join rows, and those of a soft-deleted project stay but are
hidden with it. Hard delete was rejected: it is irreversible, loses recorded evaluations, and would
leave `deleted_at` and the partial indexes as dead weight.

**Deleting a project with live KPIs, or removing an assignee who has them, is refused.** Each returns
`409` — `project_has_kpis` and `assignee_has_kpis` — carrying the count of *live* KPIs
(`deleted_at IS NULL`); the caller moves or deletes the KPIs first. The same pattern as D26, and a
service-layer obligation for the same reason: `ON DELETE RESTRICT` does not fire on a soft delete.
Rejected: cascading the soft delete to the KPIs (it discards recorded ratings) and allowing it, as
Firestore did, which stranded the KPIs.

**Serialization.** KPI `target` and `current_value` (`numeric(14,2)`) are selected as `float8`, and
project `start_date` and `due_date` as `YYYY-MM-DD` text, in the shared project and KPI column lists —
so reads and write responses agree. These are the same two fixes made for payroll (D28) and attendance
(D27): `pg` returns `numeric` as a string, which the frontend's arithmetic would concatenate, and a
`date` as a `Date` at server-local midnight, which serialises a day early east of UTC.

**Accepted defaults.** These were put forward with a recommendation and not among the questions
explicitly answered. A project's status may move between any of `draft`, `active` and `completed`.
Timestamps and the rater are server-set, and strict schemas reject unknown fields. KPI amounts are
limited to two decimal places within `numeric(14,2)`. Wire names follow the database (`snake_case`),
so a project carries `department_id` rather than Firestore's department name.

**A new project's status defaults to `active`.** `POST /api/v1/projects` defaults `status` to
`active`, not to the column's `draft`. The frontend project form defaults to `active`, so a project
created through it landing silently in `draft` would be a behavior change nobody asked for, and
parity with existing behavior is this decision's own principle. The column default stays `draft` and
`001` is untouched; the API never consults it, because the repository inserts the status explicitly.
An explicit `draft` is honored.

**Scoped roles get defaults; an explicit value is checked, never overridden.** On project create, a
`manager` or `tl` who omits `department_id` gets their own department, and a `tl` who omits
`team_lead_id` gets themselves — the same defaulting as employee create, and what the frontend form
does client-side. A value that is *present* is validated and scope-checked as given: a team lead who
names another lead, or sends an explicit `null`, is refused (`403 project_scope_denied`), not quietly
rewritten to themselves.

**Known inconsistency, deliberately deferred: request and response casing.** A project request takes
`assigned_employee_ids`, but a project in a response — a read or a write result — carries
`assignedEmployeeIds`. That is the Phase 3 read shape, kept so the Firestore parity harness can
compare it directly, and `parityService.js` and the existing read tests depend on it. Write responses
reuse the read shape on purpose, so a project looks the same whether it was just written or fetched.
It was noticed while building Phase 8 and left alone: unifying the two would change the Phase 3 read
shape, which is its own task with its own blast radius, not a side effect of the write endpoints.
A test pins the current shape, so changing it later has to be a deliberate act.

### D30 — Employee deletion leaves project and KPI references behind

`employeeRepository.deleteById` (Phase 4B) never touches projects, assignments or KPIs, and under
soft delete the `ON DELETE RESTRICT` foreign keys that would otherwise stop it are inert (see the
fourth note after D1). A soft-deleted employee therefore stays an assignee, or the team lead, of live
projects, and keeps live KPIs. D16 and D15 handle only team-lead members and department managers.

**Open — not decided here.** Phase 8's own writes accept live employees only, so they never *add*
to the problem, but deleting an employee is employee-endpoint behavior and is left for a separate
decision. The candidate shape is D15/D16-style handling inside the employee delete (remove the
employee's assignments, null a project lead), noting that it can leave a project with zero
assignees, which D29 forbids, and that their KPIs would still need a rule.

### D31 — Leave write rules and entitlement — ✅ SETTLED

> **SUPERSEDED IN PART, 2026-10-08, by [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled).**
> Management has since decided there are **no leave entitlements and no limits**. Everything in this
> entry about **pools** is superseded: the monthly 2, the December 10, the annual 14, the Eid 4, the
> type-to-pool map, the working-days rule, the Maternity cap, the over-balance refusal and the Eid date
> ranges — **including both amendments at the end of this entry.** The superseded text is kept, and
> labelled where it stands, because the reasoning is worth having if limits are ever reintroduced.
> **What stands** — the overlap refusal, the self-approval ban, who may apply, decide, cancel and delete,
> backdating, and who may read a balance — is listed in D40. The word "SETTLED" in the heading describes
> the entry as originally decided; the heading text is unchanged so existing links still resolve.

Decided before Phase 9 implementation. It answers D4 with management's entitlement rules, and settles
D5, D8 and D12 along the way. Everything here is a service-layer or API-layer rule unless it says
otherwise. `days` stays a generated column and is never accepted from a client. *(Amended
2026-10-07: a client still never supplies `days`, but the generated definition counts calendar days
and will have to be replaced — see the amendment at the end of this entry.)* *(Superseded
2026-10-08, D40: the replacement is cancelled and the calendar-day definition stands.)*

> **Amended 2026-10-07.** Management has since answered both open items below and added a rule that
> was not captured: Maternity is **16 weeks**, leave is counted in **working days** (which
> **supersedes** the calendar-days decision in this entry), and there is a **fourth pool**, 2 days
> per Eid. A **second amendment** (same day) adds that Maternity's 16 weeks is **112 calendar days**,
> that **leave type, never the date, decides the pool**, and that Eid leave therefore needs a type of
> its own — an open question. The text below is left as it was decided, with each superseded passage
> marked in place;
> the [amendment at the end of this entry](#amendment-2026-10-07--maternity-working-days-and-a-fourth-pool-eid)
> governs wherever the two disagree. Nothing in the code or the migrations has been changed to match
> yet: as committed, they still implement the rules as originally recorded here.

> **SUPERSEDED 2026-10-08 (D40): the pool system.** There are no pools. The paragraph and table below
> record what was decided and are kept for the reasoning only. The five leave types and the enum stand,
> as labels.

**The three pools and the five leave types.** The UI offers five types (`Annual`, `Sick`, `Casual`,
`Maternity`, `Emergency`) and the enum keeps all five, so the frontend and the database vocabulary are
unchanged. Management's pools do not line up with them one to one, so a **fixed type-to-pool map**,
kept in a single code module, decides which pool a request draws on:

| Leave type | Draws on | Allowance |
|---|---|---|
| `Annual`, `Casual` | the **monthly pool** | 2 per calendar month; **12 in December** (2 + the Christmas 10) |
| `Sick`, `Emergency` | the **serious-need pool** | 14 per calendar year |
| `Maternity` | **no pool** | ~~uncapped — see the open item below~~ **16 weeks = 112 calendar days** (amended 2026-10-07) |

Hajj and Umrah are applied for as `Emergency`, which is what "or similar serious need" covers. New
enum values for them were rejected: they would be invisible in the UI until the frontend changed, and
having the employee pick a pool would need a field the UI does not have. The allowance numbers and the
map live in that one code module, not in a table; moving them to a table is a later change if
management wants them editable.

> **SUPERSEDED 2026-10-08 (D40).** No allowance exists, so none of the rules below applies.

**The rules behind the numbers.**
- The monthly 2 **does not carry forward**: every calendar month starts fresh.
- The Christmas 10 are **usable only in December** and expire on 31 December, so December's allowance
  is 12. They are not a pool that outlives the month.
- The 14 are **granted per calendar year**, not once in a lifetime, and carry no proof requirement:
  there is no attachment or evidence field.
- **No proration anywhere.** The monthly 2 applies for every month an employee is employed, the full 14
  for every calendar year they are employed, and the full 10 however late in the year they joined.
  Months before the month containing `joined_on` carry no entitlement.

> **SUPERSEDED IN PART, 2026-10-08 (D40).** A balance is no longer entitlement minus usage: the endpoint
> now reports **days taken**. Still true: it is derived from `leaves` at read time and never stored, and
> rejected and deleted leave never counts. Superseded: calendar-versus-working-day counting, the per-day
> split across months, and the planned replacement of the usage view. Whether pending requests count
> toward "taken" is now an open question in D40 (they used to reserve days against an allowance).

**How a balance is computed.** A balance is derived from `leaves` at read time, never stored.
- ~~**Days are calendar days, inclusive**, which is what the generated `days` column already holds. A
  leave that spans a weekend therefore consumes the weekend days too. **Recorded as decided pending
  confirmation from management**, because "2 leaves a month" reads naturally as working days; counting
  working days would need a company weekend and public-holiday configuration that does not exist
  anywhere in the repository.~~ **SUPERSEDED 2026-10-07: days are working days, not calendar days.**
  Management confirmed the reading this bullet doubted. The company weekend is Saturday and Sunday;
  see the amendment below. The struck text is kept so the history of the decision is not lost.
- **A leave is split per calendar day across the months it covers** (D5), each day charged to the month
  it falls in, and to its calendar year for the serious-need pool. *(Amended 2026-10-07: the split
  stays per day, but only working days are charged.)*
- **Usage is approved plus pending**: a pending request reserves its days, so requests cannot be
  stacked past the allowance. Rejected, deleted and cancelled leaves never count (§8 item 7), and a
  legacy imported leave counts by its status like any other.
- The existing `employee_leave_usage` view cannot express any of this and will be replaced by a
  migration (see the note under §4.12).

**Who may apply, and who may decide.**
- **Every role may apply, for themselves only** (D12). The request's employee is always the acting
  principal, never client-supplied.
- Approval scopes are carried over from Firestore: `admin` and `hr` any request, a `manager` their
  department, a `tl` their team. **Nobody decides their own** (D8), enforced by
  `leaves_no_self_approval`. A decided request is immutable, as in Firestore.
- Approval does not change usage (pending already counted), so there is **no balance re-check at
  approval**; a rejection simply frees the days. There is no rejection reason. A decision made through
  the API always records who and when (`decision_recorded = true`, migration 003); only the importer's
  pre-existing decisions are `false`.

**Cancelling and deleting.** An employee may **cancel their own pending request** — a soft delete that
records who did it — but may not edit it: editing is cancel and re-apply, so the request an approver
saw is the one that gets approved, and a decided request cannot be cancelled by its employee. `admin`
and `hr` may delete a leave in **any status**, as the correction path for a mistaken approval.
Delete is **soft** and records the deleter in a new `deleted_by_employee_id`, which needs a **new
migration `010`** (never an edit to `001`–`009`), written at implementation time. As for `007`–`009`,
the design points are left to the migration: the FK to `employees(id)` should be `ON DELETE SET NULL`,
a `CHECK` should require `deleted_at IS NOT NULL` whenever the deleter is set, and a partial index
should serve the `SET NULL` scan. There is no hard-delete path.

**Checks added at write time.** Firestore had none of these.
- ~~A request that would exceed the balance is refused with a `409`, counting approved and pending, and
  serialised per employee against concurrent applies. `Maternity` is exempt (outside the pools),
  *(amended 2026-10-07: but it now has its own 16-week cap)*.~~ **SUPERSEDED 2026-10-08 (D40): nothing is
  refused for exceeding a balance, because there is no balance to exceed.** The **per-employee
  serialisation stays**: it is what makes the overlap check below safe against concurrent applies.
- A request that overlaps the same employee's own pending or approved leave is refused with a `409`,
  since the two would charge the same days twice.
- **Backdating is allowed** and no future limit applies, as in Firestore: sick leave is often filed
  after the fact, so a start date in the past is deliberately not refused.

**Who may read a balance.** The employee, plus approvers within the scope they can already read leaves
for (`admin`/`hr` any, `manager` their department, `tl` their team). That is a widening — Firestore let
only the employee read their own balance and denied `admin` and `hr` — but an approver needs the number
to decide.

> **Stands, 2026-10-08 (D40):** who may read it is unchanged. What it reports changes: days taken, not
> days remaining.

**Defaults, not among the questions explicitly answered.** `applied_on` is set by the server to today
in the company timezone. `start_date`, `end_date` and `applied_on` are returned as `YYYY-MM-DD` text,
the same date fix made for attendance, payroll and projects. The request carries the type, the two
dates and the reason; nothing else is accepted.

**Open items, as originally recorded — both resolved 2026-10-07; see the amendment below.**
*(Superseded 2026-10-08, D40: both resolutions are themselves superseded. With no limits, neither a
Maternity cap nor a counting rule applies.)*
- ~~**Maternity** is outside the pools and uncapped as an **interim**, because none of management's three
  rules mentions it, in the same spirit as D25. Management needs to supply a figure; until then a
  maternity request is approval-gated and nothing more.~~ **Resolved: 16 weeks.**
- ~~**Working-day counting** is recorded as calendar days pending management's confirmation, as above.~~
  **Resolved, and it overturned the recorded decision: leave is counted in working days.**

#### Amendment (2026-10-07) — Maternity, working days and a fourth pool (Eid)

> **SUPERSEDED IN FULL, 2026-10-08, by [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled).**
> Kept for the reasoning only. Maternity's cap, working-day counting and the Eid pool are all
> superseded, and the open questions at the end of this amendment are moot. **Do not implement anything
> from it.**

As relayed by the project owner on 2026-10-07, reporting management's answers, and recorded as given.
**No implementation, migration or code change accompanies this amendment.** It changes what the system
is *supposed* to do; what it does is unchanged (see "Status of what exists" below).

**1. Maternity: 16 weeks.** Maternity stays outside the **monthly and annual (serious-need) pools**, as
management stated, but it is **no longer uncapped**: management gave **16 weeks**, which they state
matches Pakistan's Maternity Benefit Act. This closes the Maternity item under the original open items
and ends the interim recorded for it. *(Updated by the second amendment below: the 16 weeks is
measured in **112 calendar days**, and Maternity's relationship to the Eid pool is moot because the
type, not the date, decides the pool. Still open: whether the cap is per request, per birth or per
year — section 6.)*

**2. Working days replace calendar days — this supersedes the earlier decision.** The company weekend is
**Saturday and Sunday**, and weekend days **do not count against any pool**. *(One exception, added by
the second amendment below: `Maternity` is counted in calendar days.)* This overturns the
calendar-days bullet earlier in this entry, which is marked superseded in place, dated, and left legible.
The rest of how a balance is computed stands: derived at read time and never stored; a leave is split
per day across the months it covers (D5), now counting only working days; usage is approved plus
pending; rejected and deleted leave never counts.

A worked example, with the dates the Phase 9 tests and end-to-end script use: 30 January to 2 February
2026 is a Friday, Saturday, Sunday and Monday. Counted in calendar days that is 2 days of January and 2
of February; counted in working days it is **1 and 1**. A leave consisting only of a Saturday and a
Sunday has **no** chargeable days (for every type except `Maternity`; an open question below).

What this requires — none of it done:
- **The generated `days` column on `leaves`** (§4.8; `end_date - start_date + 1`) computes calendar days
  and will need **replacing**. A generated column can read only its own row: it can count the weekdays
  between two dates, which is enough for a Saturday/Sunday rule, but it cannot read a table. If
  non-Eid public holidays are excluded later, or if the Eid ranges below had to influence the count, a
  generated column would not be enough. Whether `days` stays generated is therefore tied to the open
  public-holiday question in section 4. (The type-dependence for `Maternity` added by the second
  amendment does not change this: a generated column can read its own row's `type`.)
- **The per-month split in `employee_leave_usage`** (§4.12) emits one row per calendar day and so counts
  weekends; it needs the same treatment.
- **A migration** will carry both. It must be a new one, never an edit to `001`–`010`, and **it is not
  written.**
- **Code and tests that encode calendar days** — `daysBetweenInclusive`, `splitDaysByMonth` and
  `findOverage` in `leaveEntitlements.js`, and the unit tests and end-to-end script that pin the
  calendar-day numbers — will have to follow. The frontend also counts calendar days for itself when a
  leave is applied (`LeavePage.jsx`), which is a frontend item for
  [Phase 10](migration-plan.md#phase-10--frontend-cutover).

**3. A fourth pool: Eid.** This rule was not captured when D4 and D31 were written.
- **2 days per Eid**, for both **Eid-ul-Fitr** and **Eid-ul-Azha**, so **4 per year**.
- It is **separate from and additional to** the monthly pool: a month that contains an Eid can yield **4
  days** (the monthly 2 plus the Eid 2).
- It is usable **only around Eid itself**, not at any time of year.
- **The dates cannot be computed.** Eid moves each year and depends on the moon. Management's answer is
  that an **admin enters the Eid date ranges for each year**, ~~and that **leave falling inside a recorded
  range draws on the Eid pool**~~ *(withdrawn 2026-10-07: that was an inference, and it was wrong — the
  date range never reassigns a request to a pool; see the second amendment)*. (Management said "an
  admin"; whether `hr` may enter them too was not discussed.)
- **There is nowhere to store those ranges, and nothing for it exists today.** It needs a new table
  holding, at minimum, the year, which Eid, and the first and last date of the range, and therefore a
  new migration. **Neither is written.** The allowance itself (2 per Eid) belongs with the other
  numbers in `leaveEntitlements.js`; only the ranges are data.
- Eid is recorded here as **2 per Eid occasion**, so each Eid has its own 2, and not as one pool of 4
  usable at either. That is the plain reading of "usable only around Eid itself", but it is a reading;
  see the open questions.
- ~~Because a balance is derived at read time, **a recorded range reclassifies leave retroactively**:
  entering, editing or deleting a range after leave already exists changes how that leave is charged,
  and so can change the balances of leave that was already approved.~~ **SUPERSEDED 2026-10-07:** a
  range no longer decides how leave is charged, so it cannot reclassify anything; see the second
  amendment.
- ~~This is a different kind of rule from the other three. The type-to-pool map routes a request by its
  **leave type**; the Eid pool routes by **date**. How the two combine is an open question.~~
  **SUPERSEDED 2026-10-07:** the Eid pool does not route by date. Type decides every pool, so the
  question is not how the two rules combine but how a request says it is Eid leave at all; see the
  second amendment.

**4. Public holidays beyond Eid: not discussed, and undecided.** Management's answers covered the
Saturday/Sunday weekend and the Eid pool, and nothing else. Whether other public holidays — and the Eid
days themselves, if they are public holidays — are excluded from the count, or charged as ordinary
working days, was **not discussed**. Until it is decided the rule is exactly what was stated: only
Saturday and Sunday do not count. If public holidays are excluded later they would need a table of
their own, like the Eid ranges, and that would settle the question about the generated `days` column
above.

**5. Status of what exists.** Migration `010`, `leaveEntitlements.js`, the leave endpoints and the Phase 9
tests and end-to-end script, all committed, implement the rules as originally recorded: three pools,
calendar days, Maternity uncapped. They are consistent with one another and pass; they **no longer match
management's rules**, and nothing in this amendment changes them. The end-to-end script verified the
usage view against calendar-day numbers, which will need re-deriving once the view changes. There is no
production leave data to re-count: the Firestore data was never real production use
([migration-plan.md](migration-plan.md), 2026-09-21 updates) and the migration branch is not deployed. A
fourth pool and a Maternity cap also change what `GET /leave-balances` returns (two pools today) and
what the balance cards could show, which bears on
[D39](#d39--response-shape-and-leave-balance-presentation).

**6. Open questions.** Settled by this amendment: Maternity's figure (16 weeks), working days, the
weekend (Saturday and Sunday), and the existence and size of the Eid pool. *(Revised by the second
amendment below: items it resolves are struck through rather than removed.)* **Not settled:**

- **An Eid leave request when no range has been entered for that year — open.** *(Restated by the
  second amendment. The first amendment's form of this question — treat it as ordinary leave, or
  refuse all leave for the year — assumed a recorded range routes a request to the Eid pool. It does
  not, so that form no longer applies.)* Ranges now only constrain **when Eid leave may be taken**, so
  a year with no recorded range has nothing to check an Eid request against. The realistic outcomes
  are: **(a) refuse Eid requests for that year until an admin has entered its ranges** — which blocks
  Eid leave only, not leave in general; or **(b) accept them unconstrained** — which defeats "usable
  only around Eid". Both presuppose that an Eid request can be recognised as one, which is the next
  open question. *Recommendation, not settled:* (a), with some admin-visible way to tell that a year
  has no ranges yet.
- **Whether to add an Eid leave type, or find another way — open** (second amendment, item E).
- **Public holidays beyond Eid — undecided** (section 4).
- ~~**Eid versus the type-to-pool map.** Management said leave inside a recorded range draws on the Eid
  pool. Not covered: whether `Sick`, `Emergency` or `Maternity` leave inside a range draws on the Eid
  pool too, or stays on its own; and what happens to working days inside a range **beyond the 2** (a
  range wider than two days is plausible) — whether they spill into the monthly pool or are refused.~~
  **Resolved by the second amendment:** type decides the pool and the date never does, so `Sick` and
  `Emergency` stay on the 14 and `Annual` and `Casual` on the monthly pool wherever they fall. The
  "beyond the 2" question does not arise either: an Eid request that would exceed its pool is refused
  as over-balance, like any other pool (D31's existing rule, unchanged).
- **A request with no working days** (a Saturday-and-Sunday-only range), **for every type except
  `Maternity`**: accepted as a request that charges nothing, or refused. (`Maternity` counts calendar
  days, so such a request charges 2 days.)
- ~~**How Maternity's 16 weeks is measured.** As calendar time (16 × 7 = 112 days) or as working days
  under the new rule (80), and whether the cap applies **per request, per birth or per year**.~~
  **Measurement resolved by the second amendment: 112 calendar days.** **Still open:** whether the cap
  applies **per request, per birth or per year**.
- **Whether the Eid 2 are per occasion** (recorded above) or one pool of 4 usable at either. If per
  occasion, a day's Eid occasion (Fitr or Azha) has to come from the recorded range it falls in, which
  is a use of the ranges the second amendment leaves open.

#### Second amendment (2026-10-07) — Maternity in calendar days; type decides the pool; Eid needs a type

> **SUPERSEDED IN FULL, 2026-10-08, by [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled).**
> Kept for the reasoning only. With no pools there is nothing for the leave type to decide, the Maternity
> cap is superseded, and the question of whether to add an Eid leave type is moot. **Do not implement
> anything from it.**

As relayed by the project owner, reporting three further answers from management, and recorded as
given. Like the first, **it carries no implementation, migration or code change.** It also corrects one
inference made in the first amendment (item C).

**A. Maternity's 16 weeks is 112 calendar days, weekends included** — not working days, which would be
80. It is the **one exception to the working-days rule**, because maternity is a continuous period of
leave and not a count of days taken. Consequences, recorded and not done:
- The working-days rule in section 2 therefore applies to every leave type **except `Maternity`**.
  This does not conflict with "weekend days do not count against any pool", because Maternity draws on
  no pool; it is measured against its own 112-day cap.
- The generated `days` column and the usage view's per-month split become **type-dependent**: weekdays
  for `Annual`, `Sick`, `Casual` and `Emergency`, every calendar day for `Maternity`. A generated column
  can read the other columns of its own row, so `days` can still be generated — but it is no longer a
  function of the two dates alone. (The view already carries `type`.)
- A Saturday-and-Sunday-only `Maternity` request charges 2 days; the "no working days" question in
  section 6 concerns the other four types only.
- Not answered: whether the 112 days is the cap **per request, per birth or per year** (section 6).

**B. Leave type decides the pool; the date never does.** Management's answers: a `Sick` or `Emergency`
request that falls inside an Eid range still draws on the 14-per-year pool, and an `Annual` or `Casual`
request inside an Eid range still draws on the monthly pool, not the Eid pool. Eid, sick and annual
leave are **kept separate**, and a date range never reassigns a request to a different pool.

**C. This corrects the first amendment.** Section 3 recorded that "leave falling inside a recorded range
draws on the Eid pool". That was an inference and it was wrong; it is struck through there, together
with the two bullets that depended on it (retroactive reclassification, and the Eid pool routing "by
date"). What section 3 says about the Eid allowance itself — 2 per Eid, 4 a year, additional to the
monthly 2, usable only around Eid — about the dates not being computable and an admin entering them,
and about the storage that does not yet exist, stands.

**D. Consequence — recorded as a consequence, not a decision: Eid leave needs a type of its own.** If the
pool is decided entirely by type, a request can draw on the Eid pool only if its type says so, and none
of the five existing types can: `Annual` and `Casual` are the monthly pool and `Sick` and `Emergency`
the serious-need pool (both just confirmed), and `Maternity` draws on no pool. The type-to-pool map in
the table above has no place for the Eid pool, and the pool cannot be reached at all until there is a
way to say "this request is Eid leave" that is not the dates. It follows that:
- The admin-entered Eid ranges **can no longer be what routes a request to the Eid pool.** At most they
  **constrain when Eid leave may be taken**: an Eid request is valid only inside a recorded range. If
  the 2 days are per occasion, the range is also the only record of **which** Eid a day belongs to.
- A recorded range no longer changes how existing leave is **charged**, since the type has already
  decided that, so the retroactive-reclassification risk from the first amendment goes away. A range
  edited or deleted after Eid leave exists could however leave **already-approved Eid leave outside any
  range**; how to treat that is not decided.
- The stored ranges are still needed — a new table and so a new migration, neither written — but for
  validation, not routing.

**E. Open question — add an Eid leave type, or find another way?** Not decided. The realistic options:
- **(a) Add a sixth value to the `leave_type` enum** (for example `Eid`), by a new migration using
  `ALTER TYPE leave_type ADD VALUE`. Consequences: Postgres has no command to remove an enum value, so
  the migration's down file could not cleanly reverse it without recreating the type (to be checked at
  implementation); the frontend **cannot show or submit it until it is updated** — `LeavePage.jsx`
  hard-codes its type list, the default `Annual` and a literal set of `<option>` elements — which is a
  UI change under the frozen-UI rule in `AGENTS.md` (the D20 question again); and the type-to-pool map
  in `leaveEntitlements.js`, the `types` object that `GET /leave-balances` returns and the balance cards
  ([D39](#d39--response-shape-and-leave-balance-presentation)) each gain an entry. It also ends this
  entry's statement that "the enum keeps all five" types.
- **(b) A pool field on the request instead of a new type.** No enum change, but a new column on
  `leaves` and a new field in the UI — which is the objection D31 already raised against having the
  employee pick a pool.
- **(c) Reuse an existing type: not possible** under the answers above, since each of the five already
  has a pool, or none.
- **(d) Defer.** The Eid pool stays unreachable, and the 4 days a year unavailable, until this is
  decided.

*Recommendation, not settled:* **(a)**, timed with [Phase 10](migration-plan.md#phase-10--frontend-cutover),
since the leave page is being reworked for the cutover anyway, and after confirming with management
that Eid leave is a distinct kind of leave to them and what it should be called.

---

### Frontend cutover gaps (D32–D39) — all settled 2026-10-09

Found 2026-10-07 by reading the frontend end to end for [Phase 10](migration-plan.md#phase-10--frontend-cutover)
(the frontend cutover, a phase added at the same time). Each is a place where what the API
provides and what the React app needs do not meet. **All eight were settled on 2026-10-09, one at a time,
with the project owner.** Every entry keeps its analysis as it stood when the question was open and ends
with its **Decision**, so the reasoning and the options that lost are preserved. **Nothing below has been
implemented:** the decisions record what to build, and the backend and frontend work they imply is
collected under [Phase 10](migration-plan.md#phase-10--frontend-cutover).

### D32 — Session restore and the frontend's own profile

**✅ SETTLED 2026-10-09 — B: add `GET /auth/me`.** (Decision at the end of this entry. The text above it
is the analysis as recorded when the question was open.)

**What was found.** `POST /auth/login` and `POST /auth/refresh` return a `principal` of
`{ userId, employeeId, role, departmentId }` (`userRepository.findPrincipalByUserId`). The
frontend's session object is `{ employee: { id, name, email, phone, dept, pos, joinDate, empId,
role }, linkage: "uid" }`; `authSessionService.js` rejects anything with a different field set,
and `App.jsx` will not render the workspace unless `dept` is a string (separately, a manager's
read plan in `useFirestore.js` and `useScopedWorkspace.js` need it non-empty). `departmentId` is a UUID, not the department name the app keys on. There is no
`GET /auth/me`, and Firebase's `onAuthStateChanged` has no counterpart: the only way to restore a
session on page load is `POST /auth/refresh` with the httpOnly cookie, which returns the
principal above and none of the profile.

**Options.**
- **A. Widen the login/refresh principal** with the profile fields. One round trip at boot, but
  it ties an authentication response to the UI's field set, and the same object shape is what the
  middleware builds on every request.
- **B. Add `GET /auth/me`** (bearer-authenticated) returning the profile. Leaves the principal
  minimal, can be re-fetched after the user edits their own record, and is the one place the
  frontend's session shape is produced. Costs a second request at boot.
- **C. No backend change:** after refresh, the frontend reads its own row from
  `GET /employees/:id`. Self-scope already allows that. It needs the department name
  ([D33](#d33--department-names-for-manager-tl-and-employee)) and the shape translation
  ([D39](#d39--response-shape-and-leave-balance-presentation)) to be settled first, and it makes
  the session depend on the shape of a general-purpose read.

**Recommendation (accepted): B.** It keeps the security object small and gives the profile a
single source. A is the shortcut with the most coupling; C is only viable once D33 and D39 are
decided.

**Decision (2026-10-09).** The frontend gets its profile from a new **`GET /auth/me`**, authenticated by
the bearer token and mounted behind the authentication middleware — not alongside the public
login/refresh/logout routes. It returns the signed-in user's own profile: the fields the app's session
needs, with the department as a **name** as well as an id ([D33](#d33--department-names-for-manager-tl-and-employee)),
and with field naming per [D39](#d39--response-shape-and-leave-balance-presentation). **Login and refresh
are unchanged:** their `principal` stays `{ userId, employeeId, role, departmentId }`.

The boot sequence this implies is: `POST /auth/refresh` (the httpOnly cookie) → access token and
principal → `GET /auth/me` → profile → render. A failed refresh means the user is signed out. The profile
can be fetched again at any time, for example after the user's own record changes.

Why B, and what it beat: the principal stays minimal and the app's session shape has one source. **A**
(a profile inside the login and refresh responses) was rejected because it couples authentication
responses to the UI's field set and goes stale until the next refresh or reload. **C** (reading the user's
own row from `GET /employees/:id`) was rejected because it only works once D33 and D39 are settled and
ties the session to a general-purpose read endpoint.

Consequences — recorded, **not built**:
- **Backend built 2026-10-09** (uncommitted at the time of writing): `GET /api/v1/auth/me`, behind the
  authentication middleware, returning the caller's own profile with no compensation; unit, route and
  end-to-end tests (`scripts/e2e-frontend-prereqs.js`). The frontend side is still not built.
- It is a backend addition that did not exist when this was written: a route, controller, service method, tests and an
  end-to-end check. It must land **before** [Phase 10](migration-plan.md#phase-10--frontend-cutover)'s
  frontend work, since login cannot be rebuilt without it.
- Boot makes two sequential requests before the first render; the existing loading screen covers the gap.
- Its **contents are not final** until D33 (the department name) and D39 (the field naming) are settled.
  D32 fixes only *where* the profile comes from.

### D33 — Department names for manager, tl and employee

**✅ SETTLED 2026-10-09 — A: the server returns `department_name` with the id.** (Decision at the end of
this entry. The text above it is the analysis as recorded when the question was open.)

**What was found.** `GET /departments` and `GET /departments/:id` are readable by `admin` and
`hr` only (`departmentRepository` returns nothing for any other role — Phase 5's decision).
Employee and project rows carry `department_id` and no name. The frontend identifies a department
by **name**: employees have a `dept` string, projects a `department` string, a manager's read
plan is `where dept == <name>`, and `DepartmentsPage` counts employees with `e.dept === name`;
`.dept` appears 51 times in `src/` outside `src/firebase/` and `src/services/`. Firestore stored
the name denormalised on every employee document, so every role had it for free. Under the API a
manager, tl or employee has no way to turn their own `department_id` into the string the app
requires, and a non-admin writer (a manager creating a project) has no way to turn a name back
into an id.

**Options.**
- **A. Return the name with the id** — add `department_name` (beside `department_id`) to employee
  and project reads and to whatever D32 settles on. A join, no new permission: a caller learns
  only the names of departments whose rows they can already see. Writers get the id from the
  rows they already hold.
- **B. Widen `GET /departments`** so every role may read the department they belong to (id and
  name). A scope change to Phase 5's "admin and hr only" decision, but it also serves any page
  that needs a department's description or status.
- **C. Let every role read every department's name and id.** Simplest to build; reveals the whole
  organisation structure to employees, which Firestore did not do.
- **D. Change the pages to work in ids.** Honest, but it rewrites 51 usages and the manager
  read plan, against the frozen-UI rule in `AGENTS.md` §1.

**Recommendation (accepted): A**, returning both id and name. It needs no permission change
and no page change. B is the fallback if a page turns out to need more than the name.

**Decision (2026-10-09).** Employee reads, project reads and `GET /auth/me`
([D32](#d32--session-restore-and-the-frontends-own-profile)) carry a **`department_name`** beside
`department_id`, produced by a join. **No permission changes:** `GET /departments` stays readable by
`admin` and `hr` only, as Phase 5 settled. A caller learns only the names of departments whose rows they
can already see.

A finding that supports this and is worth keeping: every row a non-admin/hr caller can see belongs to
**their own department**. A manager sees their department; a tl sees their team, and
`employees_team_lead_department_foreign_key` keeps a team lead's members in the lead's department; an
employee sees only themselves; and a project's assignees are held to the project's department by
`project_assignments_employee_department_foreign_key`. So a manager, tl or employee never needs more than
one department name, their own, and the join gives it to them on every row.

How each kind of caller writes a department, which this makes workable:
- **Admin and hr** read `GET /departments` for the list, so a department name in a form maps to exactly one
  id (live department names are unique, via the partial unique index `departments_name_unique`).
- **A manager or tl** never chooses a department: it is their own, whose id is on their `/auth/me` profile
  and on every row they hold. They need no lookup.

What it beat: **B** (each role reads their own department) was rejected because it changes Phase 5's
settled admin/hr-only rule, adds a new department scope, exposes the description, status and manager id
where only the name is needed, and moves name resolution into the frontend mapper on every list. **C**
(change the pages to ids) was rejected as a rewrite of about 90 usages and the client scope helpers,
against the frozen-UI rule in `AGENTS.md` §1.

Consequences — recorded, **not built**:
- **Backend built 2026-10-09**, by a scalar subquery in the shared column lists rather than a join (same
  result, and no `FROM` or `WHERE` clause in any existing query had to change): `department_name` is on
  every employee and project read, including write responses, and on `/auth/me`. `GET /departments` is
  unchanged and still closed to manager, tl and employee. The frontend side is still not built.
- A backend addition: a join in the employee and project read queries and in `/auth/me`, with tests and an
  end-to-end check. It lands before the frontend work, alongside D32's `/auth/me`.
- The field is additive, so existing consumers of these reads are unaffected.
- The name always reflects the department's current name. A rename shows everywhere at once, where the
  Firestore copy on each employee document went stale.
- [D39](#d39--response-shape-and-leave-balance-presentation) decides what the frontend calls it: the
  mapper turns `department_name` into `dept` on an employee and `department` on a project.
- Only the reads that the pages need carry it; leaves, attendance, payroll and KPIs have no department
  field today and do not gain one.

### D34 — Delivering the password-setup link (builds on D25)

**✅ SETTLED 2026-10-09 — A: D25's interim stands for the cutover; an admin or hr relays the link.** This
revisited [D25](#d25--set-password-token-delivery-for-invited-employees--settled-interim), which said it
should be revisited once an email path or a frontend route exists. Decision at the end of this entry; the
text above it is the analysis as recorded when the question was open.

**What was found.** D25 settled an interim: the token is returned once, to the admin or hr who
issues it (`POST /employees/:id/password-token`), to be relayed out of band, and redeemed with
`POST /auth/set-password`. Nothing has changed on the backend: there is **no email transport**
(no mail library in `backend/package.json` or `backend/src`). The frontend, meanwhile, is built
for email. `EmployeesPage.save` calls `inviteEmployee` and then
`sendEmployeePasswordSetupEmail` (Firebase's `sendPasswordResetEmail`), reports "password-setup
email sent", and offers a **Resend** button; the module has no replacement. The app also has
**no route that could receive a token** — its routes are hash routes inside the authenticated
shell, and the login page has no forgot-password flow.

**Options.**
- **A. Stay with D25's interim.** After creating an employee the admin/hr UI requests a token and
  shows a copyable link once; resend means issuing a new token. Add an unauthenticated
  set-password route to the app that calls `POST /auth/set-password`. No new infrastructure. The
  "email sent" wording in the UI becomes untrue and has to change — a UI-text departure from
  `AGENTS.md` §1 that D20-style handling would have to cover.
- **B. Add real email delivery** (a mail provider, credentials, deliverability, a link template)
  and keep the app's wording. Still needs the set-password route, so it is strictly more work
  than A and also the end state D25 pointed at.
- **C. Do nothing for now.** Not viable: an employee created through the API cannot log in until
  they have a password.

**Recommendation (accepted): A for the cutover**, with the set-password route built as part of
the frontend phase, and email delivery (B) taken as its own later decision. A is what D25 was
designed to allow. A self-service "forgot password" is a separate gap: the backend has no
endpoint for it.

**Decision (2026-10-09).** [D25](#d25--set-password-token-delivery-for-invited-employees--settled-interim)'s
interim **stands for the cutover, unchanged**: a single-use token, valid for 24 hours, one live token per
user, issued by `admin` or `hr` only through `POST /employees/:id/password-token`, and redeemed with
`POST /auth/set-password` (`{ token, password }`, the password 8 to 200 characters).

What the frontend does under it:
- After an admin or hr creates an employee, the UI requests a token and shows a **copyable set-password
  link, once**, for them to pass on out of band. "Resend" means issuing a new link, which revokes the old
  one (D25).
- The app gains an **unauthenticated set-password route** that takes the token and a new password and calls
  `POST /auth/set-password`. The app already uses hash routes, so the token travels in the **URL fragment**,
  which a browser never sends in a request: it reaches neither Vercel nor the API as part of a URL.
- The pages' wording changes. "Employee account created and password-setup email sent" and the Resend
  button no longer describe what happens. That is a UI-text departure from `AGENTS.md` §1, of the same kind
  as [D20](#d20--agentsmd-1-still-forbids-the-polling-decision), and should be covered when D20 is closed.

**A workflow cost, accepted, that came to light while deciding.** `admin`, `hr`, `manager` and `tl` can all
create employees: the backend's `assertCanCreateEmployee` lets a manager create tls and employees and a tl
create employees, within their department, and the UI shows the Add Employee button to all four. But only
`admin` and `hr` can issue a token, and the create response carries none. In the Firebase flow anyone could
trigger the setup email, so a manager-created employee got it automatically. Under this decision **an
employee created by a manager or a tl cannot be activated until an admin or hr issues the link.** The UI
must say so to that creator (the wording is not decided here).

What it beat: **B** (real email delivery, the server issuing the token and emailing the link on create and
resend) is the proper end state and would close the manager/tl gap without widening anyone's power, since
the creator would never see the token. It was not chosen because it needs infrastructure that does not
exist — a mail provider, credentials, deliverability setup, a new dependency and failure handling — so it is
**its own later decision**, not a blocker for the frontend. **C** (let managers and tls issue links for
employees they can create) was rejected because it reverses D25's deliberate admin/hr-only rule and hands
credential-minting power to more people to cover a workflow gap that B solves properly.

Consequences — recorded, **not built**:
- A set-password page and route in the frontend, a service call for issuing a token, and an admin/hr-only
  presentation of the link. **Nothing new in the backend:** both endpoints already exist.
- Manager and tl creators see a notice that an admin or hr must send the link.
- An employee created as inactive gets no link ([D35](#d35--employee-status-on-create)).
- **Still open, unchanged:** a self-service "forgot password". The backend has no endpoint for it and the
  login page has no such flow; it is a separate gap, not decided here.

### D35 — Employee status on create

**✅ SETTLED 2026-10-09 — A: `POST /employees` accepts an optional `employment_status` of `active` or
`inactive`.** Decision at the end of this entry; the text above it is the analysis as recorded when the
question was open, with one correction (option C, below).

**What was found.** The employee form lets the admin create an employee as `active` or
`inactive`; the `inactive` path is handled in `EmployeesPage` ("Inactive employee account created
in a disabled state. No password-setup email was sent."), and `inviteEmployee`'s field list
includes `status`. `employeeCreateSchema` is strict and has **no status field**, so such a request
is rejected; every employee created through the API starts as `users.status = 'invited'`. Update
does accept `employment_status`. There are two enums involved (`users.status`: `active`,
`inactive`, `invited`, `suspended`; `employees.employment_status`: `active`, `inactive`,
`on_leave`, `terminated`), and `auth-matrix.md` already noted that no mapping between them is
defined. A principal is only resolved for a user who is `active` with an `active` employment
status.

**Options.**
- **A. Accept an optional `employment_status` (`active` or `inactive`) on create.** Matches the
  form. Needs a rule for what `users.status` is when an employee is created inactive (an
  `inactive` account must not be able to receive a usable token).
- **B. Remove "inactive" from the create form** — create is always active, deactivate afterwards
  with a PATCH. Simpler backend, but a UI behaviour change.
- **C. Create, then immediately PATCH to inactive** from the frontend. Two calls, not atomic, ~~with
  a window in which the account is live~~. *(Corrected 2026-10-09: that was wrong. A new account is
  `invited` with no password and cannot log in. The real cost is a half-created record: if the second
  call fails, the employee is left showing as active, in lists and in counts.)*

**Recommendation (accepted): A**, with the `users.status` rule decided inside it. C is the
option to avoid.

**Decision (2026-10-09).** `POST /employees` accepts an optional **`employment_status`**, limited to
**`active` or `inactive`**, and defaulting to `active`. The employee form works as it does today, in one
atomic call.

- **`terminated` and `on_leave` stay impossible at creation.** This narrows Phase 4's rule that
  `employment_status` is "never caller-settable" on create to those two values. The reasoning it recorded —
  a brand-new hire cannot sensibly start terminated or on leave — still holds and is what the narrowing
  preserves; `inactive` is a different thing, a pre-provisioned account.
- **`users.status` stays `invited` whichever the creator chooses.** This is the rule that option A left to
  be decided. Login requires **both** `users.status = 'active'` and `employment_status = 'active'`
  (`findPrincipalByUserId`), so an employee created inactive cannot log in either way. Staying `invited`
  keeps later activation possible: when someone sets the employee active, an admin or hr issues the
  set-password link then ([D34](#d34--delivering-the-password-setup-link-builds-on-d25)). Under D34 no link
  is issued at creation for an inactive employee.
- **No new authorization.** Whoever may create the employee may choose between the two values. There is no
  field-level gate on `employment_status` on update either, so create does not get one.

What it beat: **B** (remove "Inactive" from the create form) was rejected because it is a visible UI change
and leaves no way to create a record that does not count as active. **C** (create, then `PATCH`) was
rejected for the half-created record described in the correction above, and because it needs
partial-failure handling in the page for something one call can do.

Consequences — recorded, **not built**:
- **Backend built 2026-10-09**: `POST /employees` accepts an optional `employment_status` of `active` or
  `inactive` (default `active`); `terminated`, `on_leave` and anything else are 400. `users.status` is still
  `invited` either way, and the end-to-end run confirmed an employee created inactive cannot log in even
  after setting a password, and can once made active. The frontend side is still not built.
- A small backend addition: an optional field in the strict create schema, passed through the service, and
  written by the repository's insert (which today leaves the column to its default), with tests and an
  end-to-end check.
- The page's existing inactive path ("created in a disabled state, no setup link sent") remains correct;
  only its wording around the link changes, per D34.
- The frontend mapper ([D39](#d39--response-shape-and-leave-balance-presentation)) maps the form's `status`
  to the API's `employment_status`.

### D36 — Production cookie topology

**✅ SETTLED 2026-10-09 — same-origin through a Vercel rewrite** (option **B** in the analysis below).
(Decision at the end of this entry. The text above it is the analysis as recorded when the question was
open.)

**What was found.** The refresh token travels only as an httpOnly cookie, `SameSite=Strict`,
`Path=/api/v1/auth`, `Secure` in production (`authController.js`). A `Strict` cookie is sent only
on **same-site** requests — same registrable domain, ports ignored. In development
`localhost:5173` calling `localhost:<api port>` is same-site, so it works. In production the
frontend is on Vercel (`main` auto-deploys) and **nothing in this repository records where the API
will run**; if it is on a different registrable domain, the browser never sends the cookie and
refresh never works. CORS is configured for credentials with an origin allow-list
(`CORS_ALLOWED_ORIGINS`), but `vite.config.js` has no dev proxy, and there is no API base URL
setting in the frontend: its only environment variables are `VITE_FIREBASE_*`.

**Options.**
- **A. Same-site deployment** — frontend and API on subdomains of one registrable domain. `Strict`
  keeps working; CORS with credentials stays required.
- **B. Same-origin via a rewrite or proxy** — the frontend host forwards `/api/*` to the API, so
  the browser sees one origin. `Strict` keeps working, CORS is not needed, and the frontend can
  use a relative base URL.
- **C. Relax to `SameSite=None; Secure`** so the cookie crosses sites. Weakens the CSRF stance the
  controller deliberately chose, and browsers increasingly block third-party cookies, so it is
  unreliable as well.
- **D. Keep the refresh token in JavaScript-readable storage.** Contradicts the XSS reasoning
  recorded in `authController.js`.

**Recommendation (accepted): keep `Strict`; prefer B, or A if the API cannot be fronted.** C and
D both undo a security choice already made. This needs the deployment facts — which host, which
domain — that are not in the repository, so it cannot be settled from the code alone.

**Decision (2026-10-09).** The production frontend reaches the API through a **Vercel rewrite**: a rule in
the frontend's `vercel.json` forwards `/api/*` to the API host, so the browser only ever talks to the
frontend's own origin. This is option **B** above (same-origin through a rewrite or proxy). **The refresh
cookie is unchanged:** `httpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` in production. Because
the request path is preserved, the cookie's path still matches.

The deployment facts this was decided against: the frontend is at `https://sigma-dashboard-theta.vercel.app`,
the repository records no API host and no deployment configuration of any kind, and no domain is recorded.
`vercel.app` is on the Public Suffix List, so browsers treat each `*.vercel.app` host as its own site and a
`Strict` cookie is never sent between two of them. That is why the subdomain option (A above) is not
available without a custom domain, and why the rewrite is.

What it beat, in the choices put to the owner: **same-site subdomains on a custom domain** (A above) —
direct calls, no proxy — was not chosen because no domain is recorded; it remains available later.
**Serving the frontend from the API** was not chosen because it abandons Vercel's auto-deploy and ties
frontend and backend releases together. `SameSite=None` and a JavaScript-readable refresh token (C and D
above) stay rejected, for the reasons in the analysis.

Consequences — recorded, **not built**:
- **The frontend uses a relative base URL** (`/api/v1`), so no API base-URL variable is needed. Local
  development should mirror production with a **Vite dev proxy** forwarding `/api` to the local API, so the
  same code path runs in both. (Development would work without it, since localhost ports are same-site; the
  proxy keeps the two identical.)
- **A `vercel.json` rewrite is a frontend change for [Phase 10](migration-plan.md#phase-10--frontend-cutover).**
  Its destination is the API host, which **does not exist yet**: the API is not deployed anywhere, and where
  it will run is still to be chosen. It must be reachable from Vercel over HTTPS.
- **No change to the backend's cookie or CORS code.** Production browser traffic is same-origin, so CORS no
  longer matters for it; `CORS_ALLOWED_ORIGINS` still serves local development, and credentialed CORS can
  stay as it is.
- **Every API call passes through Vercel**: one extra hop, subject to Vercel's proxy limits, and Vercel
  becomes part of the API's availability — if Vercel is down, the app cannot reach the API. Accepted.
- **Preview deployments** each get their own origin, and a single rewrite destination means they all talk to
  the same API unless that is configured otherwise. How previews should be pointed is not decided.
- **The API will see Vercel's addresses, not the browser's.** Nothing in the API reads client IPs or
  forwarded headers today (checked), so this costs nothing now; it would matter if IP-based logging or rate
  limiting were added.
- **Not a one-way door.** Moving to a custom domain with same-site subdomains later changes the base URL and
  removes the proxy; the cookie and its `Strict` setting do not change.

### D37 — The role selector (`ROLE_MISMATCH`)

**✅ SETTLED 2026-10-09 — A: a client-side check, at login only.** (`migration-plan.md` Phase 4 had left
this as "preserved or deliberately dropped"; it is preserved.) Decision at the end of this entry; the text
above it is the analysis as recorded when the question was open.

**What was found.** The login page makes the user pick a role. The Firebase flow stores the
choice in `sessionStorage`, passes it to the `verifyAuthSession` callable on every session
establishment, and the callable refuses a mismatch (`ROLE_MISMATCH`,
`authSessionVerificationService.js:369-375`, `auth-matrix.md`), after which the app signs the
user out and shows "These credentials do not belong to the selected role." `POST /auth/login`
accepts only `{ email, password }`, and the returned principal carries the stored role. The
selector is not an authorization control — authority comes from the stored role, server-side — it
guards against signing in as the wrong persona.

**Options.**
- **A. Check on the client.** After login compare `principal.role` with the selection; on a
  mismatch call logout and show the existing message. No backend change, the wording is
  preserved, and nothing is revealed that a correct login would not show the user anyway. A
  session is briefly created and then revoked.
- **B. Check in the backend:** accept an optional `selected_role` on login and refuse a mismatch
  before issuing tokens. No session is created, but the refusal must either use the generic
  login error (losing the specific message) or a distinct one (telling someone who has guessed
  valid credentials that the role was the only thing wrong).
- **C. Drop the selector.** Simplest login; a visible UI change against `AGENTS.md` §1.

**Recommendation (accepted): A.** The selector is not a security boundary, so a client check
preserves the behaviour at no cost to the backend. It should not later be mistaken for one.

**Decision (2026-10-09).** The login page keeps its mandatory role picker. After `POST /auth/login`
succeeds, the frontend compares the returned `principal.role` with the role the user picked. On a mismatch
it calls `POST /auth/logout` and shows the existing message ("These credentials do not belong to the
selected role."). **The backend is unchanged:** `POST /auth/login` still takes only `{ email, password }`.

**The check runs at login only.** A session restore on page load — `POST /auth/refresh`, then
`GET /auth/me` ([D32](#d32--session-restore-and-the-frontends-own-profile)) — has no selection to compare
against and does not re-check. This is a **change from the Firebase flow**: there the choice lived in
`sessionStorage`, which is per tab, and the role was re-verified every time a session started, so opening a
new tab effectively forced a fresh login. Under this decision a reload or a new tab restores the session
without picking a role again. That is the more usable behaviour, and it is recorded as a departure so it is
not discovered later.

**The selector is not a security control, and must never be treated as one.** Authority comes from the role
stored on the server and resolved from the database on every request; the picker only guards against signing
in as the wrong persona. A client-side check is therefore the honest place for it. Nothing about it may be
relied on to deny access.

What it beat: **B** (the backend refuses a mismatch on login) was rejected because the refusal would have to
either use the generic login error, losing the specific message, or a distinct one, telling anyone who has
guessed valid credentials that only the role was wrong; and because it couples login to a UI convenience
and costs backend changes and tests. **C** (drop the selector) was rejected as a visible UI change against
`AGENTS.md` §1 for a control that was never a security boundary.

Consequences — recorded, **not built**:
- A session is created and then immediately revoked on a mismatch: the login response sets the refresh
  cookie, and the logout call clears and revokes it. If the logout call itself fails, a valid session
  remains for a user who simply picked the wrong role; that is harmless, since the role is not a control.
- The stored selection and its error key in `sessionStorage` (`AUTH_ROLE_STORAGE_KEY`,
  `AUTH_ROLE_ERROR_STORAGE_KEY`) are no longer needed to survive across page loads, since nothing re-verifies
  at boot; how much of that machinery to keep is a Phase 10 implementation detail.
- The `ROLE_MISMATCH` behaviour in `authSessionVerificationService.js:369-375` is not ported to the backend.

### D38 — Payroll tax: client preview vs the database

**✅ SETTLED 2026-10-09 — A: keep the preview, fix its inputs, and put a parity test behind it.** Decision
at the end of this entry; the text above it is the analysis as recorded when the question was open, with
the corrections noted inline.

**What was found.** `PayrollPage` computes `Math.round(calcTax(gross))` (`src/utils/helpers.js`)
for a preview and today also **sends** `tax` and `net` on create. The API's strict schema rejects
`gross`, `tax` and `net`: they are generated columns (D7, D28), computed by `payroll_tax_for()`.
So the client figures become preview-only. By reading, the two use the same brackets — 0 to
50,000; 5% to 100,000; 2,500 + 10% to 200,000; 12,500 + 15% beyond — and `payrollTax.test.js`
proves the **database function** against `firestore.rules`. **No test anywhere compares
`calcTax` to the database function** (`calcTax` is referenced only by `PayrollPage.jsx` and its
own definition). Possible differences, found by reading and **not tested**:
1. ~~`calcTax` works in binary floating point, where `(gross - 50000) * 0.05` can land just below
   an exact half that the database's `numeric` arithmetic sees as exactly `.5`, so the rounded
   tax could differ by 1.~~ *(Tested 2026-10-09 and **not borne out**: see the decision below.)*
2. ~~The client's gross comes from JavaScript numbers; the database's from `numeric(12,2)`.~~ *(Tested
   with the first: no difference found.)*
3. **Employee `basic` and `allowances` reach the client as strings** (`numeric` selected without a
   cast; D28 calls this a "known, separate fix"), so `emp.basic + emp.allowances + +form.bonus`
   (`PayrollPage.jsx:26`) concatenates before it adds. This one is certain, and the preview does
   not work at all until it is fixed.

**Options.**
- **A. Keep the client preview**, fix the employee money columns (cast to `float8`, as payroll's
  already are), add a parity test between `calcTax` and `payroll_tax_for()` across every bracket
  boundary and a range of cents, and show the server's `tax` and `net` from the create response
  once saved.
- **B. Remove the client calculation:** the preview asks the server (a dry-run endpoint that does
  not exist). One source of truth, at the cost of a new endpoint and a round trip per keystroke
  or button.
- **C. Show only gross in the preview** and "tax and net calculated on save". Simplest; a visible
  UI change.

**Recommendation (accepted): A**, with the employee money-column fix treated as a prerequisite.
Whatever is chosen, the saved record's figures come from the database, never from the form.

**Decision (2026-10-09).** The client keeps its tax and net **preview**. Three things make it sound, and one
test keeps it so:
1. **The employee money columns are returned as numbers.** `basic` and `allowances` are cast to `float8` in
   the employee reads, as payroll's money columns already are (D28). The bug is fixed **at the source**, so
   the frontend mapper ([D39](#d39--response-shape-and-leave-balance-presentation)) does not coerce them.
   `numeric(12,2)` has at most 12 significant digits, which a double holds exactly.
2. **`calcTax` moves into its own pure module** with no UI import. It lives in `src/utils/helpers.js` today,
   which imports the UI theme and so cannot be loaded by a plain Node test.
3. **A parity test** compares that module with an exact-integer transcription of `payroll_tax_for()` across
   every bracket boundary and a spread of cents, so the preview and the database cannot drift apart
   unnoticed. It runs with `node --test` ([D39](#d39--response-shape-and-leave-balance-presentation)), and
   the backend's existing `payrollTax.test.js`, which verifies the SQL's bracket table against
   `firestore.rules` in exact cents, is the model for the transcription.
4. **After a save the page shows the server's own `tax` and `net`** from the create response; the form's
   figures are never what is stored. The page also stops sending `tax` and `net` (and `gross`), which the API
   rejects.

**What testing found, which corrects the analysis above.** The floating-point difference listed as a possible
risk **did not appear**. The client's `Math.round(calcTax(gross))` was compared with the database function
computed in exact integer-cent arithmetic (round half away from zero, the bracket constant added outside the
rounding) for **every cent from 0.00 to 400,000.00** (40 million values) and for **2 million random sums
of basic, allowances and bonus computed as floating-point numbers the way the page adds them**. There were
**no mismatches**, including at 50,000, 100,000 and 200,000 and a cent either side. That is evidence over the
tested range, not a proof for every possible input; amounts above 400,000 were not tested, which is part of
why the permanent test in point 3 is worth having. The string-valued money columns (point 1) remain the one
certain defect, and the preview cannot work until they are fixed.

What it beat: **B** (remove the client calculation and ask the server through a dry-run endpoint) was
rejected because it costs a new endpoint and a round trip for each refresh of the figures, to guard against a
drift the evidence does not show. **C** (show only gross, with "tax and net calculated on save") was
rejected as a visible UI change against `AGENTS.md` §1.

Consequences — recorded, **not built**:
- **Built 2026-10-09:** the `float8` cast on the employee money columns (backend), and `calcTax` and
  `payrollTax` extracted to `src/utils/payrollTax.js` as a pure module. `helpers.js` still holds its own
  copy until Phase 10 re-points the page; `backend/test/payrollTaxClientParity.test.js` checks the two copies
  are textually identical and that the extracted module agrees with the database function's exact arithmetic.
  That test lives in the backend suite, because the frontend has no test runner yet (D39). The page itself is
  not changed.
  Also fixed in the same change: employee reads returned `joined_on` as a raw `Date`, which serialises a day
  early; it is now `YYYY-MM-DD` text.
- A small backend change: the `float8` cast on the employee money columns, with a test and an end-to-end
  check. It also corrects what any other consumer of those reads sees.
- A small frontend refactor: extract `calcTax`, and the parity test with it. This is a `node --test` test, so
  it depends on the frontend gaining a `test` script (D39).
- The preview remains a **second copy of the formula**. The test is what stops it drifting; changing the
  brackets still means a data migration (the generated columns do not recompute stored rows) *and* a change
  to both copies, and the test will fail until they agree again.
- `PayrollPage.jsx:26`'s `emp.basic + emp.allowances + +form.bonus` works once the columns are numbers. The
  other numeric-id assumptions on that page (`PayrollPage.jsx:24` and `:46`) are a separate Phase 10 task
  (D39).

### D39 — Response shape and leave-balance presentation

**✅ SETTLED 2026-10-09 — A: the translation lives in the frontend, as pure mappers.** *(This entry was
not on the list of gaps originally asked for; it was added because the other entries and Phase 10 depend
on it.)* Decision at the end of this entry; the text above it is the analysis as recorded when the
question was open.

**What was found.** The read endpoints return relational snake_case rows. The pages consume
Firestore-shaped documents. The only field already shaped for the frontend is a project's
`assignedEmployeeIds`.

| Domain | Frontend field | API field |
|---|---|---|
| employees | `name`, `pos`, `dept`, `joinDate`, `empId`, `status`, `teamLeadId` | `full_name`, `position_title`, `department_id`, `joined_on`, `employee_number`, `employment_status`, `team_lead_id` |
| attendance | `empId`, `date`, `checkIn`, `checkOut` | `employee_id`, `work_date`, `check_in`, `check_out` |
| leaves | `empId`, `start`, `end`, `applied` | `employee_id`, `start_date`, `end_date`, `applied_on` |
| payroll | `empId`, `month` (an English name), `year` | `employee_id`, `period_month` (1–12), `period_year` |
| kpis | `empId`, `projectId`, `current`, `ratedBy`, `ratedAt` | `employee_id`, `project_id`, `current_value`, `rated_by_employee_id`, `rated_at` |
| projects | `department`, `teamLeadId`, `startDate`, `dueDate` | `department_id`, `team_lead_id`, `start_date`, `due_date` |
| departments | `status: "Active"`, `managerId` | `status: "active"`, `manager_employee_id` |

Ids are UUIDs where the app was built for numeric strings, and the pages generate their own ids
(`id: Date.now()`), which the strict write schemas reject. One consequence is already known:
`PayrollPage.jsx:24` and `:46` use `e.id === +selEmp`, which is `NaN` for a UUID — see
[Phase 10's known hazards](migration-plan.md#phase-10--frontend-cutover), which also records
that the search which found it covered **one family of patterns only**, so there may be more.
The **leave balance** differs in kind: the pages read `leaveBalances[user.id]` as per-type
`{ t, u, r }` cards (`LeavePage.jsx`, `Dashboard.jsx`); `GET /leave-balances` returns two pools
and a type-to-pool map (D31), with Maternity on none.

**Options.**
- **A. Translate in the frontend.** Each new service module owns a mapper in both directions, so
  pages keep seeing the shape they know and the backend stays relational and snake_case on both
  reads and writes.
- **B. Make the backend return the Firestore shape** (as it already does for `assignedEmployeeIds`).
  Pages are untouched, but legacy field names enter the API and reads stop matching writes.
- **C. Change the pages to the API's shape.** The honest long-term shape, and the largest change,
  against `AGENTS.md` §1 during the migration.

For the balance cards, A needs a deliberate choice about what a per-type card now means (Annual
and Casual draw on one shared pool; Sick and Emergency on another; Maternity on none). Any
mapping is a visible change to what the cards say.

> **Superseded in part, 2026-10-08 ([D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled)).**
> The pools no longer exist, so the paragraph above about what a per-type card means is moot. The
> cards become **usage cards**: they show days taken, and there is no total or remaining figure to
> show. What exactly they show is an open question in D40. The rest of this entry (the field-name
> translation and the ids) is unaffected.

**Recommendation (accepted): A.** It matches the migration plan's own intent that pages stay
as they are. How the balance cards should read is a product question for you, not a mapping
detail. *(Since settled by D40: they become usage cards.)*

**Decision (2026-10-09).** The translation between the API's relational snake_case shape and the shape the
pages consume is done **in the frontend**. Each per-resource service module — the new ones for attendance,
leaves, payroll and departments, and the four existing callable-backed ones once they are re-pointed —
owns a mapper in **both directions**: on a read, the API's shape becomes the shape the pages already know
(`name`, `pos`, `dept`, `empId`, `joinDate`, ...); on a write, the form's payload becomes the API's payload.
**The backend stays relational and snake_case on reads and writes, and is not changed for this reason.**

**The mappers are pure functions**: no React, no network, no Firebase, in their own modules alongside the
service modules, so they can be tested without a browser. The frontend has no test runner today (only
ESLint) and this decision does not add one; Node's built-in `node --test` runs plain ES-module tests with no
new dependency, and that is how the mappers are to be tested. A `test` script in the frontend's
`package.json` is a Phase 10 task.

What the mappers are responsible for, from the analysis above:
- **Field names**, both ways, in every domain (the table above), including `department_name` →
  `dept` on an employee and `department` on a project ([D33](#d33--department-names-for-manager-tl-and-employee)),
  and the profile from `GET /auth/me` ([D32](#d32--session-restore-and-the-frontends-own-profile)).
- **Formats**: payroll `period_month` (1–12) ↔ the English month name; department `status` `active` ↔
  `"Active"`; dates stay `YYYY-MM-DD` text, which they already are. How the employee money columns are
  handled is [D38](#d38--payroll-tax-client-preview-vs-the-database)'s.
- **Ids on writes**: a client-generated `id` is never sent — the API's strict schemas reject it and the
  server assigns it. UUIDs pass through reads as the strings they are.

What a mapper **cannot** fix, and so stays a page-level task in
[Phase 10](migration-plan.md#phase-10--frontend-cutover): a page that does arithmetic on an id
(`PayrollPage.jsx:24` and `:46`, `e.id === +selEmp`, which is `NaN` for a UUID) and a page that generates
its own ids (`id: Date.now()` in `LeavePage.jsx`, `PayrollPage.jsx`, `KPIPage.jsx` and the default in
`useCollectionResource.create`). The search that found the first was one family of patterns only, so the
whole of `src/` still wants reading, not grepping, for numeric-id assumptions.

**The leave balance** is settled elsewhere and only noted here: under [D40](#d40--no-leave-entitlements-approval-is-the-only-control--settled)
the cards become **usage cards**. The mapper hands the page the days taken per leave type, a total and the
year from `GET /leave-balances` (`taken`, `total`, `year`); there is no total or remaining figure to map.
The cards' layout is a UI change made in Phase 10.

What it beat: **B** (the backend returns and accepts the Firestore shape) was rejected because it would give
the API a permanent legacy dialect on reads *and* writes — the pages send `empId`, `start` and month names
too — and reopen seven repositories and eight write schemas, leaving two dialects to maintain. **C**
(change every page to the API's shape) was rejected as too large and too risky during the migration:
every page and hook at once, against the frozen-UI rule in `AGENTS.md` §1, with no frontend tests to catch
a regression.

Consequences — recorded, **not built**:
- **The mappers are transitional.** C remains the end state, reached gradually in the deferred UI phase
  ([Phase 13](migration-plan.md#phase-13--ui-and-animation-work-deferred-not-cancelled)): each page moved to
  the API's shape lets its mapper be deleted.
- It is new frontend code, written without a framework's help, so its correctness rests on its tests. Each
  mapper should be tested in both directions, including that an editable record survives a read followed by
  a write unchanged.
- The legacy field names stay in the UI until then, which is the accepted cost of leaving the pages alone.
- Nothing in the backend changes. D33's `department_name` and D32's `/auth/me` are additive and sit under
  the same mappers.

---

### D40 — No leave entitlements: approval is the only control — ✅ SETTLED

Decided 2026-10-08, from management's answer as relayed by the project owner, **before any change to
the code**. It supersedes D31's pool system and the parts of D4 and D5 that D31 settled. This entry is
documentation only: nothing in the code, the migrations or the tests has been changed to match, and as
committed they still implement the pool model.

**What management decided.** There are **no leave entitlements and no limits.** Anyone may apply for
any number of days at any time. **Approval is the only control**: a manager, TL, HR or admin looks at
the request and decides.

**What stands from D31.** None of this depended on entitlements, and none of it changes:
- **The overlap refusal.** A request that overlaps the same employee's own pending or approved leave is
  refused with `409 leave_overlaps`, since the two would cover the same days. **The per-employee
  serialisation stays with it.** That lock was added for the balance check, but it is also what makes the
  overlap check safe: without it two simultaneous requests for the same dates both read "no overlap" and
  both go in. The end-to-end script showed exactly that when the lock was removed (five identical
  concurrent applies were all admitted).
- **The self-approval ban** (D8): nobody decides their own request. It is the database constraint
  `leaves_no_self_approval`, surfaced as `403 self_approval_denied`, and is not re-implemented anywhere.
- **Who may apply** (D12): every role, for themselves only.
- **Who may decide:** `admin` and `hr` any request, a `manager` their department, a `tl` their team. A
  decided request is immutable, enforced by a guarded `UPDATE`.
- **Cancelling and deleting:** an employee may cancel their own pending request; `admin` and `hr` may
  delete a leave in any status. Delete is soft and records the deleter — the first half of migration
  `010` (`deleted_by_employee_id`, its `CHECK` and its index).
- **Backdating is allowed**, with no future limit.
- **Who may read a balance:** the employee, plus approvers within the scope they can already read leaves
  for. Only what the balance means changes (below).
- `applied_on` is set by the server; dates are returned as `YYYY-MM-DD` text; a request carries the type,
  the two dates and the reason, and nothing else.
- **The five leave types and the enum stay**, as labels an approver and a usage figure can use. The type
  no longer decides anything.
- **`leaves.days` stays the calendar-day generated column from migration `001`.** The replacement that
  D31's amendment said it needed was never written, and is now cancelled.

**What is superseded** — kept in place, labelled, and dated 2026-10-08, because the reasoning is worth
having if limits are ever reintroduced:

| Superseded | Recorded in | Was | Now |
|---|---|---|---|
| Monthly pool | D4, D31 | 2 per calendar month, no carry-forward | none |
| December bonus | D4, D31 | 10 more in December, so 12 | none |
| Serious-need pool | D4, D31 | 14 per calendar year for `Sick` and `Emergency` | none |
| Eid pool | D31, first amendment | 2 per Eid, 4 a year | none |
| Type-to-pool map | D31 | `Annual`/`Casual` → monthly, `Sick`/`Emergency` → serious need, `Maternity` → none | none; the type is a label |
| Over-balance refusal | D31, "Checks added at write time" | `409 leave_balance_exceeded` | removed; nothing is refused for length or number of days |
| Working-days rule | D31, first amendment | Saturday and Sunday do not count | none; there is nothing to count against |
| Maternity cap | D31, both amendments | 16 weeks; then 112 calendar days | superseded under "no limits" — **not itemised by management; to be confirmed** (see below) |
| Eid date ranges | D31, first amendment | admin enters ranges each year; table to be created | not needed; the table was never created |
| Entitlement mechanics | D31, "rules behind the numbers" | no proration; months before `joined_on` carry nothing | gone |
| Per-day split across months | D5, D31 | each day charged to the month it falls in | no month to charge |

Every open question the two amendments raised is **moot**, not answered: public holidays beyond Eid,
a request with no working days, whether the Maternity cap is per request, birth or year, whether the Eid
2 are per occasion or a pool of 4, what happens to an Eid request when no range has been entered, and
whether to add an Eid leave type.

**The answer to D4 is now: there are none.** D4 asked where entitlements come from. They do not exist.
The mock values in `src/data/leaveBalance.js` (Annual 15, Sick 10, Casual 5) were already superseded and
are now obsolete.

**The balance endpoint stays, with a new meaning.** `GET /api/v1/leave-balances` is kept, with the same
scoping, but it reports **days taken, not days remaining**. There is no entitlement, so there is no total
and no remaining figure. The frontend's balance cards (`LeavePage.jsx`, `Dashboard.jsx`) become
**usage cards**: a UI change, which bears on [D39](#d39--response-shape-and-leave-balance-presentation)
and [Phase 10](migration-plan.md#phase-10--frontend-cutover).

**What this costs.** Stated plainly, because it is a lot. Phase 9 was built, tested and verified
against the pool model: four commits (`6198a36` the decisions, `75937e6` the implementation and
migration `010`, `57aaa03` the tests and end-to-end script, `19da2aa` the two amendments), 983 tests
passing, and 161 end-to-end results against a real database. The pool half of that is now to be removed
or rewritten. The counts below were taken from the files and test titles on 2026-10-08; the test split
is by title and approximate, and should be confirmed when the work is done.

- **The entitlement module goes.** `backend/src/services/leaveEntitlements.js` (208 lines) holds the
  numbers, the type-to-pool map, the day-splitting and the over-balance rule. **Seven files import it:**
  four production files (`leaveRepository.js`, `leaveBalanceService.js`, `leaveMutationService.js`,
  `leaveSchemas.js`), the end-to-end script, and two test files. A few constants and helpers may move;
  the rest is deleted.
- **The over-balance check goes** from `leaveMutationService.js` (94 lines), and the usage read, the
  `joined_on` read and the validation payload go from `leaveRepository.js` (289 lines).
- **The balance service is rewritten.** `leaveBalanceService.js` (46 lines) computes entitlement minus
  usage; it has to report usage only.
- **The usage view was built for the pool model.** The second half of migration `010` replaced
  `employee_leave_usage` with a view that splits every leave per calendar day into per-month counts.
  Migrations are never edited, so changing or dropping it takes a **new migration**, which is not
  written.
- **Tests: about 89 of the 205 leave tests (43%) must be removed or rewritten.** About **73 are removed
  outright** (all 56 in `leaveEntitlements.test.js`, 6 in the mutation service tests, 2 in the repository
  tests, 6 in the route tests, 3 in the balance service tests) and about **16 are rewritten** (4, 5, 5 and
  2 in those same four files). About 116 survive in substance; of those, 10 balance-scoping tests need
  new fixtures, and 6 migration tests describe a view that is now dead weight and stay true only because
  `010` cannot change.
- **The end-to-end script is largely affected.** About 60 of its 150 check sites mention pools,
  entitlement, balance or the view (23 are explicitly about the view). Two of its race proofs assert the
  over-balance behaviour — one expects exactly 2 of 8 concurrent applies to be admitted, the other expects
  a balance refusal from a waiting request — and must be redesigned around overlap. The view section,
  which was the part most wanted verified against real Postgres, now checks a view the design may not need.
- **Docs:** D4, D5, D31 and its two amendments, the notes under §4.8 and §4.12, D39, and
  `migration-plan.md` Phases 9 and 10.
- **Frontend:** the balance cards become usage cards.

**What it does not cost.** The authorization service and its 20 tests; the decide, cancel and delete
paths; the overlap check and its lock; the self-approval ban; the soft delete and its deleter column;
the date serialisation; and the scoping of who may read a balance. Nothing is deployed, Phase 9 is not
connected to the frontend, and no production leave data exists, so no user is affected.

**Open — recorded, not decided:**
- **What "days taken" counts.** Approved leave only, or approved and pending shown separately. Pending
  requests used to reserve days against an allowance; that reason is gone.
- **Over what period:** a calendar month, a calendar year, all time, or a requested `as_of`.
- **Per leave type, in total, or both.**
- **Whether a leave spanning two periods is split or attributed whole** — D5's two options again, now
  with nothing forcing the split.
- **The fate of `employee_leave_usage`:** reuse it as the basis of the days-taken figure, change it, or
  drop it. Any of those is a new migration.
- **Whether the 366-day `MAX_LEAVE_DAYS` bound in `leaveSchemas.js` stays.** It was never a management
  rule: it bounded how many rows the per-day view could generate. With "no limits" it is the one limit
  left in the code, so keeping it is a decision.
- **Maternity.** Management did not itemise the 16-week cap, so superseding it rests on "no limits". The
  figure was set by reference to Pakistan's Maternity Benefit Act, so it is worth confirming that a
  cap is not wanted here.

**Implemented 2026-10-08.** The rework under "What this costs"
has been done. What was changed, and what it settled:
- `leaveEntitlements.js` is deleted, with the over-balance check, the pool code and the 366-day bound;
  `LEAVE_TYPES` now lives in `backend/src/utils/leaveTypes.js`.
- **Migration `011_restore_leave_usage_view`** restores `employee_leave_usage` to its pre-`010` shape —
  `leave_year` and `days_used`, approved leave only, each leave attributed whole to the year it starts in
  — and its down file puts `010`'s per-month view back. `010` was not edited, and its `deleted_by` half
  stands.
- **`GET /api/v1/leave-balances` now reports days taken:** `{ employee_id, as_of, year, taken, total }`,
  with all five leave types always present in `taken`. The `employee_id` and `as_of` parameters are
  unchanged and only the year of `as_of` matters. Scoping is unchanged.
- **Open questions this answered, by following from restoring the pre-`010` view** — so worth confirming
  rather than assuming: only **approved** leave counts (a pending request is not counted until it is
  approved); the figure is **per type and in total**; the period is a **calendar year**; a leave counts
  **whole in the year it starts in**, so 30 December to 2 January is four days in the earlier year; the
  view was **kept, restored**, not dropped; and `MAX_LEAVE_DAYS` was **dropped**, so a 400-day request is
  accepted.
- **Still open:** the Maternity cap (superseded under "no limits", not confirmed), and whether pending
  requests should be shown separately from approved ones.
- **Results:** the whole suite went from 983 to 934 tests, and the leave tests from 205 to 156, a net of
  −49. By file, net: the entitlement tests −56 (the whole file), the mutation service tests −4, the route
  tests −1, the repository tests +3, the balance service tests +2, the migration tests +7 (for `011`),
  the authorization tests 0. Those are net figures: within them, pool tests were removed and the
  remaining affected tests rewritten, and "no limits" regression tests were added. The end-to-end script went from 161 to 139 results and passed against `sigma_hrm_scratch`, again after
  rolling `011` back and re-applying it; with the per-employee lock removed it fails exactly the two
  race proofs that depend on it.
