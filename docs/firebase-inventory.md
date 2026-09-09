# Firebase layer inventory

Captured from `migration/postgres` @ `2bab7c0`. Every claim carries a `file:line`
reference. This document describes **what exists today**, so the PostgreSQL rebuild can
be checked against it. It proposes no changes.

Companion document: [auth-matrix.md](auth-matrix.md).

---

## 1. Deployment shape

`firebase.json` sets `functions.source = "functions"`, runtime `nodejs22`.
`functions/package.json` declares `firebase-admin` 14.3.0, `firebase-functions` 7.3.2,
entry point `index.js`.

**There are 7 exported functions. Every one is an `onCall` callable.**

```
functions/index.js:651  exports.inviteEmployee
functions/index.js:662  exports.linkLegacyEmployeeUid
functions/index.js:673  exports.verifyAuthSession        (only one with a CORS allowlist)
functions/index.js:690  exports.getScopedWorkspace
functions/index.js:698  exports.manageProject
functions/index.js:719  exports.manageKpi                (defined :709)
functions/index.js:731  exports.manageEmployee           (defined :721)
```

### There are no triggers and no scheduled jobs

A search across `functions/*.js` for `onRequest`, `onSchedule`, `onDocumentWritten`,
`onDocumentCreated`, `onDocumentUpdated`, `onDocumentDeleted`, `pubsub`, `scheduler`,
`functions.auth` and `beforeUserCreated` returns **no matches**. The only
`firebase-functions` import in `functions/index.js:7` is
`const { HttpsError, onCall } = require("firebase-functions/v2/https")`.

**Consequence for the rebuild:** there is no background compute, no cron, and no
trigger-driven denormalization to reproduce. The Postgres API needs no job scheduler.

---

## 2. Callable inventory

### 2.1 `inviteEmployee` — `functions/index.js:651`

Creates a new employee. Resolves the caller's own employee record, loads every existing
employee for policy evaluation, runs the invitation policy, creates a Firebase Auth user
with no password, then batch-creates the `employees` and `authLinks` documents keyed by
the new Auth UID. Rolls back the Auth user if the Firestore batch fails
(`employeeInvitationService.js:374-385`).

**Reads**
| Source | Fields | Where |
|---|---|---|
| `employees` where `uid == callerUid`, limit 2 | `role`, `status`, `dept` | `employeeInvitationService.js:105-110` |
| `employees` — **full collection scan** | `email`, `role`, `dept`, doc id | `employeeInvitationService.js:163-166` |
| Firebase Auth | `getUserByEmail(email)` | `employeeInvitationService.js:230` |

**Writes** — one `firestore.batch()`, two `batch.create` calls, committed atomically
(`employeeInvitationService.js:320-326`):
- `employees/{authUid}` ← `name, email, phone, dept, pos, basic, allowances, joinDate,
  role, status`, optional `teamLeadId`, plus `uid, empId, createdByUid, createdAt,
  updatedAt` (`:365-372`). `empId` is derived as `` `EMP-${uid}` `` (`:303-305`).
- `authLinks/{authUid}` ← `{employeeId, createdAt, updatedAt}` (`:314-318`). Here
  `employeeId === authUid`.
- Firebase Auth `createUser` (`:273-277`), `deleteUser` on rollback (`:338`).

**Authorization**
- Caller authenticated, else `UNAUTHENTICATED` — `:44-53`.
- Caller maps to exactly one employee — `CREATOR_NOT_FOUND` / `CREATOR_NOT_UNIQUE`, `:121-132`.
- Caller active — `:146-148`, re-checked `employeeInvitationPolicy.js:225-228`.
- Role-assignment allowlist — `employeeInvitationPolicy.js:233-235`, table at `:4-10`.
- Department scope for manager/tl; dept is then **forced** to the creator's — `:243-248`.
- A `tl` creator may only set `teamLeadId` to themselves — `:263-267`.

**Input control** — allowlist `ALLOWED_INPUT_FIELDS` (`employeeInvitationPolicy.js:12-24`);
denylist `FORBIDDEN_INPUT_FIELDS` (`:26-53`) covering `password, pass, uid, authUid,
firebaseUid, id, docId, empId, employeeId, createdBy, createdAt, updatedAt, claims,
customClaims, permissions, isAdmin` and more, enforced at `:171-180` with `FORBIDDEN_FIELD`
taking precedence over `UNSUPPORTED_FIELD`.

**Frontend caller:** `src/services/employeeInvitationService.js:28` →
`src/pages/employees/EmployeesPage.jsx:221`.

---

### 2.2 `linkLegacyEmployeeUid` — `functions/index.js:662`

Self-service repair for pre-`authLinks` data. Given the caller's uid and token email,
finds the employee document belonging to them (by `uid`, then by `email`) and atomically
stamps `uid` onto it while creating `authLinks/{uid}`. Idempotent — returns
`alreadyLinked: true` and backfills only a missing `authLinks` doc.

**Reads** — `employees` by `uid` and by `email` (both limit 2, `legacyEmployeeLinkService.js:164-171`);
inside the transaction, `employees/{candidateId}` and `authLinks/{callerUid}` (`:310-313`).

**Writes** — all inside `firestore.runTransaction` (`:309-346`):
- `authLinks/{callerUid}` created (`:321-324`, `:339-344`).
- `employees/{candidateId}` — **only** `{ uid, updatedAt }` (`:338`).

**Authorization** — uid and email normalization → `INVALID_AUTH_IDENTITY` (`:47-69`);
email must match the record (`:128-136`, re-checked in-transaction at `:315`); employee
must be active (`:138-146`); uniqueness violations → `DUPLICATE_UID_LINK` (`:374-380`),
`EMPLOYEE_NOT_FOUND` (`:402-408`), `DUPLICATE_EMAIL_LINK` (`:409-415`); already bound to a
different uid → `UID_LINK_CONFLICT` (`:420-426`).

**Input** — none. The callable reads no `request.data` at all (`index.js:664-667`).

> **⚠ No frontend caller.** A client wrapper exists at
> `src/services/legacyEmployeeLinkService.js:25-28,55`, but **nothing in `src/` imports
> that module**. The logic is still live server-side as the self-healing path inside
> `verifyAuthSession` (`index.js:60-61` → `authSessionVerificationService.js:291`). The
> *behavior* must survive the migration; the *public endpoint* may not need to. See
> [auth-matrix.md](auth-matrix.md) ambiguity A3.

---

### 2.3 `verifyAuthSession` — `functions/index.js:673`

The login gate. Resolves `authLinks/{uid}` → employee document, self-healing via the
legacy link service when the link is absent, then verifies uid / email / status / role and
returns a sanitized principal.

This is the **only** function with an explicit CORS allowlist:
`VERIFY_AUTH_SESSION_ALLOWED_ORIGINS = ["https://sigma-dashboard-theta.vercel.app"]`
(`index.js:10-12`), applied at `index.js:673-678`.

**Reads** — `authLinks/{uid}` (`authSessionVerificationService.js:282-284`, re-read after
repair at `:297`); `employees/{link.employeeId}` for `uid, email, status, role`
(verification `:339-376`) plus `name, phone, dept, pos, joinDate, empId` (response `:378-390`).

**Writes** — **none directly.** The legacy-repair path can write via §2.2.

**Authorization**
- `validateSelectedRole` — `:81-90`, `VALID_ROLES` at `:8`.
- `authLinks` doc must have **exactly** `employeeId, createdAt, updatedAt` → `AUTH_LINK_CONFLICT` (`:196-213`).
- `UID_MISMATCH` (`:340-347`), `EMAIL_MISMATCH` (`:348-354`), `EMPLOYEE_INACTIVE` (`:355-361`),
  `DATA_INTEGRITY_FAILURE` (`:362-368`).
- **`ROLE_MISMATCH` (`:369-375`) — the stored role must exactly equal the role selected at
  login.** The login screen's role picker is authoritative-checked, not trusted.

**Input** — only `request.data?.selectedRole` (`index.js:683`).

**Frontend callers:** `src/services/authSessionService.js:46` →
`src/pages/login-page/LoginPage.jsx:78` and `src/hooks/useAuthSession.js:34`.

---

### 2.4 `getScopedWorkspace` — `functions/index.js:690`

Read-only aggregation for **managers and team leads only**, because Firestore rules cannot
express these joins client-side. Managers get everything in their department; TLs get their
own projects plus projects assigned to their direct reports.

**Reads** — `authLinks/{uid}` (`scopedWorkspaceService.js:509-514`); `employees/{employeeId}`
for `uid, status, role, dept` (`:197-230`); then:
- Manager path (`:422-445`): `projects` where `department == dept`; `employees` where `dept == dept`.
- TL path (`:447-480`): `employees` where `teamLeadId in [...]`; `projects` where
  `teamLeadId in [...]`; `projects` where `assignedEmployeeIds array-contains-any [...]`.
- KPI path (`:482-504`): `kpis` where `projectId in [...]`; `kpis` where `empId in [...]`,
  the latter filtered to legacy KPIs with no `projectId` (`:502`).

`PROJECT_FIELDS` at `:7-19`, `KPI_FIELDS` at `:20-34`. Note `MAX_QUERY_VALUES = 30`
chunking (`:5`, `:274-280`) and string/number id variant handling (`:245-256`) — a Postgres
port removes the chunking concern but must preserve the id-type tolerance while legacy
numeric ids exist.

**Writes** — **none.** Purely read-only.

**Authorization** — `EMPLOYEE_UID_MISMATCH` (`:200-206`); `EMPLOYEE_INACTIVE` (`:207-213`);
**role allowlist `new Set(["manager","tl"])` → `ROLE_NOT_ALLOWED` (`:214-220`)** — admin, HR
and employee are *denied here*; `PRINCIPAL_SCOPE_INVALID` for a manager with no dept (`:222-228`).

**Input** — none (`index.js:692`).

**Frontend caller:** `src/services/scopedWorkspaceService.js:65` → `src/hooks/useScopedWorkspace.js:93`.

---

### 2.5 `manageProject` — `functions/index.js:698`

`create` / `update` / `delete` of a project in one transaction. Validates the payload,
loads the existing project, validates that every referenced team lead and assignee is
active, correctly-roled and in the right department, then enforces role- and
department-scoped authority over **both** the existing and the candidate project.

**Reads** (all `transaction.get`) — `authLinks/{uid}` (`projectMutationService.js:639`);
principal `employees/{employeeId}` (`:641-642`); `projects/{projectId}` for update/delete
(`:646-648`); `employees/{id}` for every referenced id, old and new (`:444-475`).

**Writes**
- create → `transaction.create` (`:703`)
- update → `transaction.set` (`:704`) — **full document overwrite, not a merge**
- delete → `transaction.delete` (`:683`)

Record fields at `:697-701`. On update `createdAt` is preserved; `updatedAt` is always the
server clock.

**Authorization** — `PRINCIPAL_UID_MISMATCH` (`:198-205`); `PRINCIPAL_INACTIVE` (`:206-212`);
`MANAGING_ROLES = new Set(["admin","hr","manager","tl"])` (`:36`) enforced at `:214-220`, so
`employee` is denied; `PRINCIPAL_SCOPE_INVALID` (`:222-228`); scope over the existing
project via `canManageExisting` (`:511-519`, failure → `PROJECT_SCOPE_DENIED` at `:673-679`);
candidate identity scope (`:546-564`) preventing a manager moving a project out of their
department; candidate assignment scope (`:521-544`) requiring a TL to own every assignee;
reference integrity (`:478-509`).

**Input control** — exact operation schemas (`:342-366`); `PROTECTED_PROJECT_FIELDS`
denylist (`:21-34`) including the legacy `name`; `PROJECT_INPUT_FIELDS` exact list (`:6-15`);
status allowlist `draft|active|completed` (`:35`); `dueDate >= startDate` (`:321-329`);
`assignedEmployeeIds` non-empty and duplicate-free (`:281-298`).

**Frontend caller:** `src/services/projectMutationService.js:50` → `src/firebase/useFirestore.js:12-16`.

---

### 2.6 `manageKpi` — `functions/index.js:709`, exported `:719`

`create` / `update` / `delete` of a KPI in one transaction. Two distinct update kinds: a
**progress update** (title/target/current/weight/period/status) and a **rating update**
(`rating` alone, 1–10) which stamps `ratedBy`/`ratedAt`. Supports project-linked and
"legacy" KPIs with no `projectId`; legacy KPIs cannot be rated.

**Reads** — `authLinks/{uid}` (`kpiMutationService.js:725-730`); principal employee
(`:731-736`); `kpis/{kpiId}` (`:752-760`); `projects/{projectId}` (`:515-528`);
`employees/{id}` for the project's TL, every assignee, and the KPI's target employee (`:529-543`).

**Writes**
- create → `transaction.create` (`:748`), record at `:740-747`, `rating/ratedBy/ratedAt`
  initialized to `null`, doc id auto-generated (`:709-711`)
- delete → `transaction.delete` (`:765`)
- rating update → `transaction.update` with `{rating, ratedBy, ratedAt, updatedAt}` (`:769-777`)
- progress update → `transaction.update` with the supplied subset plus `updatedAt` (`:780-783`)

**Authorization** — `PRINCIPAL_UID_MISMATCH` (`:228-235`); `PRINCIPAL_INACTIVE` (`:236-242`);
`MANAGING_ROLES` (`:6`) at `:243-249`; project-scoped authority `canManageProject` (`:583-596`)
→ `KPI_SCOPE_DENIED` (`:613-615`); legacy-KPI authority `canManageLegacy` (`:598-603`) →
`:637-639`; assignment check → `KPI_EMPLOYEE_NOT_ASSIGNED` (`:566-579`).

Two prohibitions worth carrying into Postgres verbatim:
- **Self-rating ban** — `SELF_RATING_DENIED`, `:616-618`.
- **Legacy rating ban** — `LEGACY_RATING_NOT_ALLOWED` for KPIs with no `projectId`, `:621-627`.

**Input control** — operation schemas (`:403-425`); `CREATE_KPI_FIELDS` (`:8-17`);
`PROTECTED_KPI_FIELDS` (`:26-44`), with `projectId`/`empId` exempted on create (`:331-332`)
but fully protected on update (`:359-366`); `PROGRESS_UPDATE_FIELDS` (`:18-25`); a `rating`
update must be the **only** key (`:367-379`); `target > 0`, `current >= 0`,
`1 <= weight <= 100` (`:314-327`); rating an integer 1–10 (`:301-312`).

> **⚠ `ALLOWED_KPI_STATUSES = new Set(["active"])` (`:7`) — `"active"` is the only writable
> KPI status.** A KPI can never be stored as completed or archived through this callable.
> See [auth-matrix.md](auth-matrix.md) ambiguity A1.

**Frontend caller:** `src/services/kpiMutationService.js:56` → `src/firebase/useFirestore.js:17-22`.

---

### 2.7 `manageEmployee` — `functions/index.js:721`, exported `:731`

Handles **`update` and `delete` only** — there is no `create` (creation is `inviteEmployee`).
Runs a *preview* transaction to authorize and snapshot an identity version, mutates
Firebase Auth **outside** the transaction, then runs a second transaction guarded by an
optimistic-concurrency check. On failure it compensates the Auth change, and if
compensation fails returns a `partialResult`.

**Reads** — `authLinks/{callerUid}` (`employeeMutationService.js:568`); principal and target
employee documents (`:576-577`); `departments` where `name == candidate.dept` limit 2,
requiring `status` active (`:474-488`); `employees/{candidate.teamLeadId}` (`:490-509`);
`employees` where `email == candidate.email` limit 2 (`:511-520`); `authLinks` where
`employeeId == target.id` limit 2 (`:522-539`); Firebase Auth `getUser` / `getUserByEmail`
(`:623-658`).

**Writes**
- update → `transaction.set` (`:817`) spreading the stored document first, so unknown
  pre-existing fields are **preserved**; `teamLeadId` is either set or deleted (`:815-816`)
- delete → `transaction.delete` on `employees/{targetId}` **and** on the target's
  `authLinks` document (`:767-768`)
- Firebase Auth `updateUser` (`:669`), `deleteUser` (`:729`), compensating `updateUser` (`:692`)

> **⚠ Ordering hazard.** The Auth delete happens *before* the Firestore delete
> (`:756-757` then `:760`), so a failure between them leaves login revoked but the row
> present. Surfaced as `DELETE_PARTIAL_CLEANUP` with
> `{employeeId, accessRevoked: true, cleanupPending: true}` (`:777-787`). A Postgres
> rebuild that owns both sides in one transaction removes this failure mode entirely.

**Authorization**
- `PRINCIPAL_UID_MISMATCH` (`:394-400`), `PRINCIPAL_INACTIVE` (`:401-403`).
- Role gate: `ROLE_ASSIGNMENTS[principal.role]` must exist and the principal must not be
  `employee` (`:404-406`).
- **Hierarchy** — `assertHierarchy` (`:416-450`):
  - delete: `SELF_DELETE_DENIED` (`:418-420`); admin may delete anyone else; hr only
    `manager|tl|employee` (`:421-422`); **manager and tl cannot delete at all** (`:423`).
  - update: `SELF_ROLE_CHANGE_DENIED` (`:426-428`); admin anything; hr → target and
    candidate role in `{manager,tl,employee}` (`:430-431`); manager → `{tl,employee}` and
    both departments equal theirs (`:432-438`); tl → both must be `employee`, same dept,
    `teamLeadId === principal.id` before **and** after (`:439-447`).
- **Compensation gate** — `PAYROLL_ROLES = new Set(["admin","hr"])` (`:35`); only these two
  roles may change `basic` or `allowances` → `COMPENSATION_CHANGE_DENIED` (`:452-463`).
- Optimistic concurrency over an `identityVersion` of
  `{uid, email, status, role, dept, teamLeadId, updatedAt}` (`:541-557`) →
  `EMPLOYEE_TRANSACTION_CONFLICT`.
- Auth/Firestore consistency → `TARGET_AUTH_CONFLICT` (`:641-643`), `TARGET_UID_CONFLICT` (`:528-537`).

**Input control** — `EDITABLE_FIELDS` (`:8-20`); `PROTECTED_FIELDS` (`:21-26`) checked first
(`:242-255`); per-field normalizers (`:256-266`); business rule that only employees may have
a team lead (`:410-414`).

**Frontend caller:** `src/services/employeeMutationService.js:75` → `src/firebase/useFirestore.js:23-27`.

---

## 3. Collection catalogue

Nine collections. The canonical list is `functions/canonicalRelationshipMigration.js:4-14`,
matching the nine `match` blocks at `firestore.rules:790-840`.

**There is no `users`, `teams`, `companies` or `reports` collection in Firestore.**
`reports` is a derived view — `src/pages/reports/ReportsPage.jsx:24-30` computes everything
from already-loaded arrays. `users`, `teams` and `companies` exist only in the *Postgres*
schema (see §6).

| Collection | Written by CF | Written by frontend | Read by CF | Read by frontend | Note |
|---|---|---|---|---|---|
| `employees` | yes | no (rules deny) | yes | yes | |
| `authLinks` | yes | no (rules deny) | yes + rules engine | no | invisible to client |
| `departments` | no | **yes** (admin) | yes | yes (admin/hr) | no CF ever writes it |
| `projects` | yes | no (rules deny) | yes | yes | |
| `kpis` | yes | no (rules deny) | yes | yes | |
| `leaves` | no | **yes** | no | yes | no CF involvement at all |
| `attendance` | no | **yes** | no | yes | no CF involvement at all |
| `payroll` | no | **yes** | no | yes | no CF involvement at all |
| `leaveBalances` | no | no | no | yes (employee) | **read, never written** |

### 3.1 `employees`
Doc id is the Firebase Auth UID for invited employees (`employeeInvitationService.js:321`);
legacy seeded docs use numeric string ids (`src/data/employees.js:2`).
Fields: `name, email, phone, dept, pos, basic, allowances, joinDate, role, status,
teamLeadId, uid, empId, createdByUid, createdAt, updatedAt`, plus a legacy numeric `id`.
Frontend read plan at `src/firebase/useFirestore.js:510-549`.

> `createdByUid` is written (`employeeInvitationService.js:369`) and **never read anywhere**.

### 3.2 `authLinks`
Doc id is the Auth UID. Exactly three fields — `employeeId, createdAt, updatedAt` — enforced
in five separate services and again at `firestore.rules:62-71`. Written only by the Admin
SDK; `firestore.rules:790-792` denies all client access. The rules engine itself resolves
identity through it (`firestore.rules:9-11,57-82`).

### 3.3 `departments`
Fields `id, name, description, managerId, status ('Active'|'Inactive'), createdAt`, plus a
tolerated `_docId` — enumerated at `firestore.rules:726-756`. Written **directly by the
frontend**, admin only (`src/firebase/useDepartments.js:53-67`). Read by admin/hr, and by
`manageEmployee` which requires the department to exist and be active
(`employeeMutationService.js:474-488`).

> Casing mismatch: rules require `'Active'|'Inactive'` (`firestore.rules:763`) while
> `employeeMutationService.js:484-487` lowercases before comparing. Nothing validates that
> `managerId` points at a real employee.

### 3.4 `projects`
Fields `title, description, department, teamLeadId, assignedEmployeeIds[], startDate,
dueDate, status, createdAt, updatedAt` (`projectMutationService.js:6-20,35`), plus a legacy
`name` selected at `scopedWorkspaceService.js:7-9`. `name` is in `PROTECTED_PROJECT_FIELDS`
(`:21-34`), so it can be read but never written — a read-only legacy remnant.

### 3.5 `kpis`
Fields `projectId (nullable), empId, title, target, current, weight, period, status, rating,
ratedBy, ratedAt, createdAt, updatedAt`. KPIs without a `projectId` are "legacy" and cannot
be rated (`kpiMutationService.js:621-627`).

### 3.6 `leaves`
Exactly nine fields, `hasOnly`-enforced: `id, empId, type, start, end, days, reason, status,
applied` (`firestore.rules:368-418`). `days` must equal the inclusive day count computed from
`start` and `end` (`:406-411`). **Delete is denied to everyone** (`:820`).

### 3.7 `attendance`
Exactly nine fields: `id, empId, date, status, checkIn, checkOut, notes, createdAt,
updatedAt` (`firestore.rules:448-496`). `date` may not be in the future; `absent`/`leave`
forces both times empty; `createdAt <= updatedAt`.

### 3.8 `payroll`
Exactly eleven fields: `id, empId, month, year, basic, allowances, bonus, deductions, tax,
net, status` (`firestore.rules:561-618`). **The rules recompute tax and net**:
`tax == calculatedPayrollTax(payrollGross(payroll))` (`:614`) and
`net == gross - deductions - tax` (`:615`), with a progressive bracket at `:549-559`.

### 3.9 `leaveBalances`
Doc id is the employee document id. Fields `Annual, Sick, Casual`, each a map `{t, u, r}`
with `r == t - u` (`firestore.rules:660-685`).

> **⚠ Read but never written.** `firestore.rules:837-840` denies `list, create, update,
> delete`. No Cloud Function writes it. The only writer in the repo is the one-shot dev
> seeder `src/firebase/seedFirestore.js:34-36`, documented as "Run this ONCE… then remove
> it" and invoked from no live code path. Leave approval in `src/pages/leave/LeavePage.jsx`
> never decrements the balance, so `u` and `r` are permanently stale. See
> [auth-matrix.md](auth-matrix.md) ambiguity A2.

---

## 4. Relationship graph

```
                      authLinks/{firebaseUid}
                             │ employeeId  (1:1, unique)
                             ▼
   departments ──dept(name)──► employees/{docId} ◄──teamLeadId (self-FK)
       │ managerId ───────────► (employee docId)
       │
       │ name ◄──department── projects/{id} ──teamLeadId──► employees
       │                          │ assignedEmployeeIds[] ─► employees
       │                          ▲
       │                          │ projectId (nullable)
       │                       kpis/{id} ──empId──► employees
       │                          └──ratedBy──► employees
       │
       └─ leaves/{id}     ──empId──► employees
          attendance/{id} ──empId──► employees
          payroll/{id}    ──empId──► employees
          leaveBalances/{employeeDocId}  ← the doc id *is* the foreign key
```

Foreign keys, from `canonicalRelationshipMigration.js:412-508`:

| Source | Field | Target | Required |
|---|---|---|---|
| `authLinks` | `employeeId` | `employees` doc id | yes, 1:1 with `employees.uid` |
| `employees` | `uid` | Auth UID = `authLinks` doc id | no (unlinked legacy) |
| `employees` | `teamLeadId` | `employees` doc id, role `tl`, same dept | no |
| `employees` | `dept` | **`departments.name`, by name not id** | yes |
| `departments` | `managerId` | `employees` doc id | no |
| `projects` | `teamLeadId` | `employees` doc id | no |
| `projects` | `assignedEmployeeIds[]` | `employees` doc ids | yes, non-empty |
| `projects` | `department` | `departments.name` | yes |
| `kpis` | `empId` | `employees` doc id | **yes** |
| `kpis` | `projectId` | `projects` doc id | no |
| `kpis` | `ratedBy` | `employees` doc id | no |
| `leaves` / `attendance` / `payroll` | `empId` | `employees` doc id | **yes** |
| `leaveBalances` | *document id* | `employees` doc id | yes |

### 4.1 Three identifiers that are routinely confused

1. **`uid`** — the Firebase Auth UID. Stored on `employees.uid`; used as the `authLinks`
   document id.
2. **`employeeId`** — the canonical employee *document id*. Appears only as
   `authLinks.employeeId`. For invited employees this equals the Auth UID
   (`employeeInvitationService.js:321-322`); for legacy employees it is a numeric string.
3. **`empId`** — **two unrelated meanings.** On `employees` it is a cosmetic display string
   `EMP-<uid>` (`employeeInvitationService.js:303-305`). On `kpis`, `leaves`, `attendance`
   and `payroll` it is the *foreign key* to the employee document id.

**Implication:** the Postgres schema needs `employees.id` and `employees.auth_uid` as
distinct columns, because both shapes are live simultaneously.

### 4.2 String-vs-integer id tolerance

Legacy documents store relationship values as integers where current ones use strings. This
is tolerated in **three places at once**:
- rules — `valueMatchesDocumentId` (`firestore.rules:45-55`), `matchesCurrentEmployeeId` (`:156-169`)
- functions — `relationshipVariants` (`scopedWorkspaceService.js:245-256`) queries both forms
- frontend — `getRelationshipIdVariants` (`src/firebase/useFirestore.js:68-80`)

Eliminating this is the entire purpose of `canonicalRelationshipMigration.js`. Until it has
run, a Postgres ETL must handle both forms.

---

## 5. Role model

Five role strings: **`admin`, `hr`, `manager`, `tl`, `employee`**. There is no shared
constants module between `functions/` and `src/`; they are redeclared in eight places.

| File:line | Constant | Content |
|---|---|---|
| `functions/employeeMutationService.js:27` | `ROLES` | all five |
| `functions/employeeMutationService.js:28-34` | `ROLE_ASSIGNMENTS` | admin→all; hr→`{manager,tl,employee}`; manager→`{tl,employee}`; tl→`{employee}`; employee→`{}` |
| `functions/employeeMutationService.js:35` | `PAYROLL_ROLES` | `{admin, hr}` — gates `basic`/`allowances` |
| `functions/employeeInvitationPolicy.js:4-10` | `ASSIGNABLE_ROLES` | same hierarchy, array form |
| `functions/authSessionVerificationService.js:8` | `VALID_ROLES` | all five |
| `functions/projectMutationService.js:36` | `MANAGING_ROLES` | `{admin, hr, manager, tl}` |
| `functions/kpiMutationService.js:6` | `MANAGING_ROLES` | `{admin, hr, manager, tl}` |
| `functions/scopedWorkspaceService.js:214` | inline | `{manager, tl}` — the only place admin/hr are *excluded* |

Client mirror at `src/utils/permissions.js:9-14`, labels `:17-23`, helpers `:25-27`,
assignable-roles duplicate `:168-171`, capability map `:177-192`.

Backend already matches: `backend/src/utils/roles.js:1-11` defines the same five strings plus
`COMPANY_WIDE_ROLES`, `DEPARTMENT_SCOPED_ROLES`, `TEAM_SCOPED_ROLES`. **Role strings are the
one thing that migrates cleanly.**

**Scoping semantics, consistent across all services:** admin and hr are global; manager is
scoped to `employees.dept`; tl is scoped to dept **plus** `employees.teamLeadId == <tl's
employee doc id>`; employee has no management authority anywhere.

---

## 6. `canonicalRelationshipMigration.js`

A **manual CLI tool, not a deployed function.** `functions/index.js` never requires it, and
`functions/package.json` has no script entry for it. It runs only via
`node functions/scripts/migrateCanonicalRelationships.js` (guard at `:245-256`).

It rewrites legacy relationship values so every foreign key stores the canonical document id
rather than a legacy `data.id` alias or a numeric id (`canonicalRelationshipMigration.js:401-524`),
relocates `leaveBalances` documents so the doc id equals the canonical employee id (`:301-354`),
and validates `authLinks` as a strict bijection with `employees.uid` (`:356-393`).

**Safety rails worth replicating in any Firestore → Postgres ETL:**
- Dry-run by default; `--apply` requires `--confirm-project=<exact projectId>` (`:44-49`, `:624-632`)
- `--target=production|emulator` must agree with `FIRESTORE_EMULATOR_HOST` (`:633-639`)
- Refuses to apply if the plan contains **any** conflict (`:640-642`)
- Every write preconditioned on the document's `updateTime` captured at plan time (`:651-661`)
- Writes chunked to 450 per transaction (`:24`, `:562-580`)
- Idempotent — already-applied updates are skipped

**There is no Firestore → Postgres ETL anywhere in the repo.** `backend/README.md:24-26`
states existing Firebase data must not be imported until a separate, approved migration step.

---

## 7. What `backend/src/` implements today

**One route: `GET /api/v1/health` → `{"status":"ok"}`** (`backend/src/app.js:26` →
`routes/apiRouter.js:5` → `routes/healthRoutes.js:5` → `controllers/healthController.js:1-3`).
Everything else falls through to `notFound` and `errorHandler` (`app.js:27-28`).

Scaffolding with **zero production callers**:
- `middleware/authentication.js` — a factory requiring a `verifyAccessToken` callback that
  **does not exist anywhere in the repo**; never mounted in `app.js`. Its own error message
  reads "A future access-token verifier is required."
- `repositories/employeeRepository.js:3-10` — a real parameterized `findByUserId` query, but
  nothing constructs the repository, so the API process never opens a database connection.
- `services/employeeScopeService.js:7-17` — maps a role to a scope descriptor that nothing
  consumes; there is no `WHERE`-clause builder.
- `validation/commonSchemas.js` — two Zod schemas, imported nowhere.

Six of the nine collections — `projects`, `kpis`, `leaves`, `attendance`, `payroll`,
`leaveBalances` — have **no Postgres table at all**. Conversely `companies` and `teams` exist
in Postgres with **no Firestore counterpart**. Full gap analysis, including field-level
mismatches and the unmapped `name` → `first_name`/`last_name` split, is in
[auth-matrix.md](auth-matrix.md) §6.
