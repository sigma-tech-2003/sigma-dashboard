# Migration plan: Firebase → Node + PostgreSQL

Phased sequence from today's state to a working Express + Postgres backend with Firebase
removed. Ordered so **the application is never broken between phases**.

Companion documents: [schema-design.md](schema-design.md) (the target schema),
[firebase-inventory.md](firebase-inventory.md) and [auth-matrix.md](auth-matrix.md) (what
exists today).

**This document proposes; it changes nothing.** No code, config, dependency, Firebase rule or
existing migration has been modified.

---

## Starting state

- **Firebase is 100% authoritative.** 7 callables, 847 lines of rules, 9 collections.
- **`backend/` serves one route**: `GET /api/v1/health`. No authorization, no database
  connection at runtime, six of nine collections have no table.
- **The frontend is realtime** — `src/services/firestoreService.js:393` uses `onSnapshot`.
- Migration branch `migration/postgres` is not deployed; `main` auto-deploys to Vercel.

## Principles this ordering follows

1. **Firebase stays authoritative for a domain until that domain's write cutover lands.**
   Every phase before then is additive and invisible to users.
2. **Read before write, per domain.** A read cutover is trivially reversible; a write cutover
   is not.
3. ~~**The seam is `src/services/*.js`.** Those modules already isolate every Firestore call
   from every component. Cutover swaps their implementation and touches no page or
   component.~~ **This premise is wrong, and the plan was ordered around it.** See the
   correction directly below.

> **Correction (2026-10-07).** Reading the frontend end to end for the cutover showed that
> `src/services/*.js` is **not** the only place Firebase is called, and that cutover
> **cannot** be done without touching more than the service modules. Firebase and Firestore
> are called from three places:
>
> 1. **`src/services/`** — ten modules. `firestoreService.js` uses the Firestore SDK directly
>    (`onSnapshot`, `getDocs`, `setDoc`, `updateDoc`, `deleteDoc`); `authService.js` uses
>    Firebase Auth; six more wrap callables (`verifyAuthSession`, `inviteEmployee`,
>    `manageEmployee`, `manageProject`, `manageKpi`, `getScopedWorkspace`); two have no
>    importer in `src/` at all (`authEmployeeVerificationService.js`,
>    `legacyEmployeeLinkService.js`).
> 2. **`src/firebase/useFirestore.js` and `src/firebase/useDepartments.js`** — the data hooks
>    every page is fed through, and which `App.jsx` imports. They are not service modules:
>    they build Firestore query descriptors (`createWhereSource`,
>    `createInternalQuerySource`, `createDocumentSource`) from `firestoreService.js`, chunk
>    `in`-queries to 30 values, and decide per role which collections to subscribe to.
> 3. **`src/hooks/`** — `useAuthenticatedCollection.js` subscribes with `onSnapshot` (via
>    `subscribeToCollectionSources`), `useCollectionResource.js` writes with
>    `createDocument` / `updateDocument` / `deleteDocument` **directly**, with no service
>    module in between, and `useAuthSession.js` listens with `onAuthStateChanged`.
>
> Consequences: attendance, leaves, payroll and departments have **no service module at
> all** today — their writes go straight from a hook to Firestore, so each needs a new one;
> and pages cannot be assumed untouched (see the known hazards under Phase 10). The
> frontend work is therefore a phase of its own — [Phase 10](#phase-10--frontend-cutover) —
> not a line item inside Phases 4-9.
4. **Smallest blast radius first.** Domains cut over in ascending order of coupling, so early
   mistakes are cheap.
5. **No dual-write.** Single company, small dataset — a brief per-domain freeze plus a final
   re-sync is simpler and more honest than a dual-write layer nobody will maintain. See
   [Rollback](#rollback-posture).

---

## Phase 0 — Reconcile the schema — ✅ DONE (not yet applied to a database)

**Built.** `001_initial_core_hr_hierarchy.up.sql` rewritten in place, with a matching
`.down.sql`, implementing [schema-design.md](schema-design.md) in full: `full_name` replaces
`first_name`/`last_name`; the `teams` table and `employees.team_id` are gone in favour of
`employees.team_lead_id`; compensation columns added; the `companies` singleton index; all six
missing tables; `payroll_tax_for()`; the generated columns (`leaves.days`, `payroll.gross`,
`payroll.tax`, `payroll.net`); every `CHECK` constraint; and the `employee_leave_usage` view.

**Depended on.** [D2](schema-design.md#d2--rewrite-001-or-add-002) and
[D1](schema-design.md#d1--soft-or-hard-delete) — both settled.

**Verified.** 22 tests in `backend/test/` pass, none of which connect to a database:
`migrationFoundation.test.js` asserts every table, enum, generated column, named constraint
and index exists, that `teams`/`first_name`/`last_name` are gone, that every uniqueness rule is
partial on `deleted_at IS NULL`, and that the down migration reverses everything in a safe
order. `payrollTax.test.js` proves the bracket table reproduces `firestore.rules:549-559` at
every boundary using exact integer arithmetic over cents, including the exact-half cases that
distinguish rounding modes.

**Not yet verified — requires a real server.** No PostgreSQL exists in this environment, so
the DDL has never been executed. Two things to confirm on first `db:migrate` against a scratch
database: that the constant-expression index `companies_singleton` is accepted
([D21](schema-design.md#d21--companies_singleton-uses-an-index-on-a-constant-expression)), and
that `payroll_tax_for()` returns the tested values under `numeric` arithmetic.
**Do not run `db:migrate` against anything but a scratch database.**

**Stays on Firebase.** Everything. No user-visible change.

---

## Phase 1 — Backend foundation: identity, principal, scope — ✅ DONE

**Built.** argon2id password hashing (`src/utils/password.js`); token issuance and
verification (`src/services/tokenService.js`); the `verifyAccessToken` that
`middleware/authentication.js` always demanded, now supplied and **mounted** in
`src/routes/apiRouter.js` behind the public health route; principal resolution in
`src/repositories/userRepository.js`; `employeeScopeService` rewritten from a descriptor
generator into a real parameterised `WHERE` builder; the preserved gates and the amended
deletion authority in `src/services/employeeAuthorizationService.js`; migration
`002_auth_sessions` for refresh tokens.

**Verified.** 74 tests pass without a database, plus an end-to-end run against
`sigma_hrm_scratch`: every role's scoped list matched §6 exactly, and a valid unexpired
token was rejected the instant its account was deactivated.

**Two things fixed in passing.** `employeeRepository.findByUserId` still selected
`team_id`, a column Phase 0 removed — it would have failed against the real schema. And
`getEmployeeScope` still keyed a team on `teamId`; it now uses `team_lead_id` per §6.

**Carried forward.** The TL reassignment requirement is enforced in the service layer, not
by the database: employees are soft-deleted (D1) and `ON DELETE RESTRICT` does not fire on
an `UPDATE` that sets `deleted_at`. Deleting a team lead with no members returns
`team_lead_replacement_undecided` pending [D16](schema-design.md#d16--deleting-a-tl-who-has-no-members).

### Original scope (for reference)

**Build.** The parts `backend/src/` currently only gestures at:
- password hashing and verification (argon2 or bcrypt — new dependency, needs approval)
- token issuance and the real `verifyAccessToken` that
  `middleware/authentication.js:4` demands but which does not exist; **mount the middleware**
- principal resolution: `users` ⋈ `employees` → `{userId, employeeId, role, departmentId, isTeamLead}`
- turn `employeeScopeService.getEmployeeScope` from a descriptor generator into an actual
  `WHERE`-clause builder, per [schema-design.md §6](schema-design.md#6-authorization-model-in-the-new-stack)
- the authorization gates worth preserving verbatim from the callables: `SELF_DELETE_DENIED`,
  `SELF_ROLE_CHANGE_DENIED`, `PAYROLL_ROLES` for compensation, and the amended deletion
  authority

**Depends on.** Phase 0. [D6](schema-design.md#d6--role-on-users-rather-than-employees) (role
on `users`), [D10](schema-design.md#d10--session-strategy--settled) — **settled: short JWT +
refresh table + per-request status check** — and
[D14](schema-design.md#d14--row-level-security) (RLS or service-layer scoping; still
service-layer, unchanged).

**Verified by.** Unit tests for the scope predicate covering all five roles; integration tests
asserting every role × collection × operation cell in
[auth-matrix.md §3](auth-matrix.md#3-role--collection--operation-matrix) either matches
Firestore or differs *deliberately* per the decisions. That matrix is the test oracle — this
is the phase where writing it pays off.

**Stays on Firebase.** Everything. Auth exists in Postgres but nothing uses it.

---

## Phase 2 — ETL: Firestore → Postgres — ✅ DONE

**Built.** A one-way, idempotent importer, modelled on the safety rails already proven in
`functions/canonicalRelationshipMigration.js`: dry-run by default, `--apply` requiring an
explicit database confirmation (the same gate `db:rollback` uses), refusal to proceed with
any unresolved conflict, and a written plan before any write. `src/services/
firestoreImportService.js` is the pure planner (no I/O); `src/repositories/
firestoreImportRepository.js` is the only part that touches Postgres, applying a plan in
one transaction; `scripts/import-firestore.js` is the CLI. Two new migrations support it —
`003_leave_decision_provenance` (see [schema-design.md §4.8 Amendment](schema-design.md#amendment-phase-2-migration-003_leave_decision_provenance))
and `004_firestore_import_bookkeeping` ([D23](schema-design.md#d23--firestore_import_refs-bookkeeping-table)).

Every transformation identified below is implemented:
- seed exactly one `companies` row
- `employees.dept` (a department **name**) → `department_id` uuid, case-insensitively
- `employees.name` → `full_name` (no split needed — that is why the decision matters)
- split each employee into a `users` row (email, role, status) and an `employees` row —
  including employees who were never linked to a Firebase Auth account at all, since D11
  means every account resets its password at cutover regardless
- `authLinks.employeeId` → `employees.user_id`, enforcing the bijection that
  `canonicalRelationshipMigration.js:356-393` validates at runtime
- `projects.assignedEmployeeIds[]` → `project_assignments` rows, reconciled to exactly the
  given set on re-import
- `departments.status` `'Active'` → `'active'`; `payroll.month` name → `1-12`;
  attendance `""` times → `NULL`
- resolve the string-vs-integer legacy id tolerance
  ([firebase-inventory.md §4.2](firebase-inventory.md#42-string-vs-integer-id-tolerance)) once
  and for all — Postgres uuids admit no such ambiguity
- decided leaves with no recorded approver import with their real status and
  `decision_recorded = false` rather than being discarded or fabricated (D22)

**Depended on.** Phases 0-1. [D17](schema-design.md#d17--employee_number-generation) —
resolved for the importer's purposes: `employee_number` is preserved verbatim from the
source `empId`, sidestepping the still-open generation policy for *new* hires, which is a
Phase 4 concern. [D9](schema-design.md#d9--attendance-uniqueness--settled) — the importer **fails
loudly on duplicate attendance rows**, exactly as intended.

**Verified.** 125 tests pass without a database. Then end-to-end against
`sigma_hrm_scratch`: dry-run and `--apply` produced identical row counts; the imported
approved leave landed with `decided_by_employee_id NULL`, `decided_at NULL`,
`decision_recorded = false`, status preserved as `'approved'`; a *new* row inserted
directly with `decision_recorded` left at its default `true` and no approver was still
rejected by `leaves_decision_consistent`, proving the relaxation is scoped to imported rows
only; re-running the identical import produced zero new rows and the same row ids
throughout — genuine idempotency, not just the on-paper version in the unit tests.

**Run against your real export.** Firestore held 6 employees and 1 department, but 25 of
the 32 kpi/leave/payroll records referenced 7 distinct employee ids — six legacy numeric
ids and one newer one — that no longer exist: employees deleted without their dependent
records being cleaned up alongside them. Per your decision, those records are skipped
rather than imported with a fabricated employee or left blocking the whole run — a
genuinely deleted employee has no row to attach them to. `--skip-orphans` (opt-in;
omitting it leaves `missing-employee-reference` blocking exactly as before) exists
specifically for this, downgrading only that one conflict category to a reported skip. It
does not extend to `ambiguous-employee-reference`, `missing-department-reference`, the
`authLinks` bijection checks, or `department-manager-wrong-department` — all of those still
block regardless of the flag.

**Found and fixed during verification, not by inspection**
([D24](schema-design.md#d24--department-manager-must-work-in-the-department-they-manage--found-and-fixed)):
the importer let a department manager assigned to the wrong department reach Postgres as an
uncaught foreign-key crash instead of a clean conflict. Fixed by adding the missing
cross-reference check before the write is attempted.

**Stays on Firebase.** Everything. Postgres is a shadow copy, read by nothing.

> **Update (2026-09-21):** there will be no data migration. The HRM was never in production
> use — the Firestore data is dummy development data — and new data will be created directly
> in Postgres going forward. The importer above is built and verified (see **Verified**
> above) but will not be run against real data.

---

## Phase 3 — Read-only API and parity harness

**Build.** `GET` endpoints for all domains under `/api/v1`, scoped by the Phase 1 predicate.
No writes. Plus a parity harness that, for a given user, fetches the same data from Firestore
and from the API and diffs it.

**Depends on.** Phase 2.

**Verified by.** The parity harness run for one user of each of the five roles, asserting the
API returns exactly what that user sees in the app today. This is the phase that proves the
scope predicate is right *before* anyone depends on it.

**Stays on Firebase.** Everything. The frontend has not changed; the API is exercised only by
tests.

> Two deliberate differences will show up here and should be asserted, not fixed:
> managers and TLs get scoped project and KPI reads directly, where Firestore denies them and
> routes through `getScopedWorkspace` (ambiguity A8, widening confirmed at
> [D19](schema-design.md#d19--carried-forward-unresolved-ambiguities)).

> **Update (2026-09-21):** the parity harness (`scripts/parity-harness.js`) is built and
> ready but will not be run. With no Firestore→Postgres import happening (see the Phase 2
> update above), there is no shared data between the two systems left to compare.

---

## Phase 4 — Identity cutover: login and employees

The highest-risk phase. Auth and employees move together because they are inseparable:
`inviteEmployee` creates an Auth user *and* an employee record in one batch, and
`verifyAuthSession` reads the employee to build the session
([firebase-inventory.md §2.1, §2.3](firebase-inventory.md#2-callable-inventory)).

**Build.** `POST /auth/login`, `/auth/logout`, password reset; `POST /api/v1/employees`
(replacing `inviteEmployee`), `PATCH`, `DELETE` (replacing `manageEmployee`) including the
TL replacement transaction from
[schema-design.md §6.1](schema-design.md#61-the-tl-replacement-flow). Swap
`src/services/authService.js`, `authSessionService.js`, `employeeInvitationService.js` and
`employeeMutationService.js` to call the API.

**Depends on.** Phase 3. **[D11](schema-design.md#d11--firebase-auth-passwords-cannot-be-exported)
is a hard blocker** — Firebase Auth password hashes cannot be exported, so every user must
reset their password at cutover. That is a communicated operational event, not a code change,
and it needs scheduling before this phase is attempted. Also
[D16](schema-design.md#d16--deleting-a-tl-who-has-no-members) (TL with no members) and
[D13](schema-design.md#d13--deletion-authority-managers-deleting-managers).

> **Update (2026-09-21):** D11 is no longer a blocker. There is no data migration — the
> Firestore data was never real production use, and there are no existing Firebase Auth
> users whose passwords would need resetting. New accounts are created directly in Postgres.

**Verified by.** A staged rehearsal on a copy: every role logs in, sees the correct scope,
and the amended deletion authority behaves as specified — including that a TL delete without a
valid replacement is **rejected by the database**, not merely by the service. Confirm
`ROLE_MISMATCH` behavior (`authSessionVerificationService.js:369-375`) is preserved or
deliberately dropped.

**Stays on Firebase.** `projects`, `kpis`, `leaves`, `attendance`, `payroll`, `departments` —
all still read and written through Firestore. **This is the phase where both systems are live
at once**, so employees data is authoritative in Postgres while the rest still reads Firestore
employee documents. Keep the ETL running one-way for those collections until each cuts over.

> **Correction (2026-10-07):** the frontend half of this phase — "swap
> `src/services/authService.js`, `authSessionService.js`, `employeeInvitationService.js` and
> `employeeMutationService.js` to call the API" — **was not done**, and the statements in
> Phases 4-8 that a domain "stays on Firebase" describe the *backend's* readiness only: the
> React app still reads and writes Firebase for every domain. Because `firestore.rules`
> requires a Firebase Auth identity (`isAuthenticated()` is `request.auth != null`, line
> 5-6), the browser cannot be on Postgres for login and on Firestore for data. See
> [Phase 10](#phase-10--frontend-cutover) for what that means.

---

## Phase 5 — Departments

**Build.** Departments CRUD. Smallest domain, admin-only writes, read by admin and HR only.

**Depends on.** Phase 4.

**Verified by.** Admin can create, rename and deactivate; **HR is denied every write** —
confirming the decided rule and matching `firestore.rules:768,773,786`.

**Stays on Firebase.** `projects`, `kpis`, `leaves`, `attendance`, `payroll`.

> The frontend still shows HR the department write buttons
> (`src/firebase/useDepartments.js:18`). They fail today against rules and will fail
> identically against the API — unchanged behavior, but the UI bug (ambiguity A4) is worth
> fixing here.

---

## Phase 6 — Attendance

**Build.** Attendance CRUD, with the temporal checks that cannot live in the database — no
future dates, `updated_at` bounds — implemented in the service layer per
[schema-design.md §5](schema-design.md#5-where-each-firestorerules-validation-goes-and-why).

**Depends on.** Phase 5. [D9](schema-design.md#d9--attendance-uniqueness--settled).

**Verified by.** The structural constraints reject bad rows at the database level:
`check_out > check_in`, and `absent`/`leave` forcing null times. Service tests cover the
future-date rejection.

**Stays on Firebase.** `projects`, `kpis`, `leaves`, `payroll`.

---

## Phase 7 — Payroll

**Build.** Payroll CRUD, admin/HR only. The tax brackets and the net invariant are **already
enforced** by the generated columns from Phase 0 — this phase writes no arithmetic, it only
supplies `basic`, `allowances`, `bonus` and `deductions` and lets the database compute the rest.

**Depends on.** Phase 6. [D7](schema-design.md#d7--generated-tax-and-net-remove-manual-override-forever)
(generated columns forbid manual tax override) and
[D1](schema-design.md#d1--soft-or-hard-delete), which for payroll may be legally constrained
regardless of the general policy ([schema-design.md §8](schema-design.md#8-soft-vs-hard-delete--every-place-the-choice-matters) item 5).

**Verified by.** Recompute every imported payroll row and diff against Firestore; a row that
disagrees is a pre-existing bad record, not a migration defect. Confirm whether `draft` should
become reachable (ambiguity A5) — current design preserves today's behavior by defaulting to
`processed`.

**Stays on Firebase.** `projects`, `kpis`, `leaves`.

---

## Phase 8 — Projects and KPIs

**Build.** Both together — they are coupled through `kpis.project_id`, and both are served by
the same callable today. Replaces `manageProject`, `manageKpi` **and** `getScopedWorkspace`.
The self-rating and legacy-rating bans are already database constraints from Phase 0; this
phase must not re-implement them, only surface clean errors.

**Depends on.** Phase 7.

**Verified by.** The scoped-workspace fan-out is replaced by a join — assert a manager and a TL
see exactly the same projects and KPIs the callable returns today. Attempting a self-rating
must fail at the **database**, proving the constraint rather than the service is doing the work.

**Stays on Firebase.** `leaves` only.

> This phase retires the `MAX_QUERY_VALUES = 30` chunking and the string/int id variant
> handling in `scopedWorkspaceService.js` — a single SQL join replaces roughly 120 lines.

---

## Phase 9 — Leaves

Last, because it is the only domain with an unresolved data dependency.

**Build.** Leave CRUD, the approval workflow, and balances computed from the
`employee_leave_usage` view rather than stored. The TL self-approval ban is a database
constraint from Phase 0.

**Depends on.** Phase 8, and **[D4](schema-design.md#d4--where-do-leave-entitlements-come-from)
is a hard blocker**: balances are computed as `entitlement − usage`, and entitlement exists
nowhere in the repo except mock data (`src/data/leaveBalance.js`). Without it the leave UI
cannot render a balance. Also [D5](schema-design.md#d5--does-an-approved-leave-in-a-prior-year-still-count)
(year-boundary attribution) and [D12](schema-design.md#d12--can-non-employees-take-leave).

**Verified by.** Computed balances reconcile against Firestore's stored `leaveBalances` for
employees whose data was never stale — expect mismatches, since nothing has decremented those
counters since seeding (ambiguity A2). **Mismatches confirm the computed model is correct**,
not that the migration is wrong.

**Stays on Firebase.** Nothing, as far as the *backend* goes: this is the last domain. The
frontend is a different matter — it still calls Firebase for everything until
[Phase 10](#phase-10--frontend-cutover) (see the correction under Principle 3).

> **Superseded in part, 2026-10-08 — [D40](schema-design.md#d40--no-leave-entitlements-approval-is-the-only-control--settled).**
> Management has decided there are **no leave entitlements and no limits**; approval is the only
> control. This phase's description above was written for the pool model and is partly wrong now:
> - **The D4 "hard blocker" has dissolved.** There is nothing to compute `entitlement − usage` from,
>   because there is no entitlement. D5 (year-boundary attribution) is superseded too.
> - "Balances computed from the `employee_leave_usage` view" becomes **days taken**: the endpoint
>   reports usage, not what remains.
> - The "Verified by" reconciliation against Firestore's stored `leaveBalances` is moot: those counters
>   held entitlement and remaining figures, which no longer exist.
>
> **Rework required — Phase 9 as built is partly wrong, and the cost is real.** It was built, tested
> and verified against the pool model, and a large part of it must be removed or rewritten. The detail
> and the counts are in D40; in short:
> - `leaveEntitlements.js` (208 lines, imported by seven files) goes, along with the over-balance check,
>   and the balance service is rewritten from "remaining" to "taken".
> - The per-month usage view (the second half of migration `010`) was built for the pool model.
>   Changing or dropping it takes a **new migration**, which is not written.
> - About **89 of the 205 leave tests (43%)** must be removed or rewritten (about 73 removed outright,
>   about 16 rewritten), and about 60 of the end-to-end script's 150 check sites, including two of its
>   race proofs, which must be redesigned around overlap.
> - What survives: the authorization service, decide, cancel and delete, the overlap refusal and its
>   lock, the self-approval ban, the soft delete and its deleter column, and who may read a balance.
>
> Nothing is deployed and Phase 9 is not connected to the frontend, so no user is affected.
>
> **Proposed sequencing — not decided:** do this rework **before Phase 10**, because Phase 10 builds the
> frontend's usage cards against the balance endpoint's new meaning and would otherwise build them
> twice. The open questions in D40 about what "days taken" counts need answering first.
>
> **Rework done, 2026-10-08.** The entitlement module, the
> over-balance check and the pool code are removed; migration `011` restores the usage view; the balance
> endpoint reports days taken; the tests and the end-to-end script were rewritten (suite 983 → 934, leave
> tests 205 → 156, end-to-end 139 results passing against `sigma_hrm_scratch`). Several of D40's open
> questions were answered by restoring the pre-`010` view and are listed there for confirmation. This
> removes the Phase 9 rework from the path to Phase 10.

---

## Phase 10 — Frontend cutover

*Added 2026-10-07. No earlier phase scheduled this work, and the phase that followed it
(then called Phase 10, now Phase 11) assumed it had already happened.*

**Why this phase exists.** Phases 4-9 built and tested the backend. None of them touched the
React app: nothing in `src/` calls `backend/`, and every page still reads and writes Firebase.
The old plan covered the frontend with one line in Phase 4 ("swap `src/services/*.js`"), which
was never carried out, and with the premise corrected under Principle 3 — that the swap
touches no page or component. This phase is that work.

**What this changes about cutover and rollback.** `firestore.rules` requires a Firebase Auth
identity (`isAuthenticated()` is `request.auth != null`, lines 5-6). Once the browser signs in
against Postgres it holds no Firebase identity, so it can no longer read or write **any**
Firestore collection. The login swap and every domain's data swap therefore have to ship
together. The "each domain cutover is a flag flip" description under
[Rollback posture](#rollback-posture) does not hold for the frontend — no such per-domain
switch exists in `src/services/` or the hooks — unless Firebase Auth were kept running
alongside, which nothing in this plan
proposes. The 2026-09-21 updates establish that Firestore holds no real production data, which
is what makes a single cutover survivable; in practice it makes this one window, rehearsed on a
copy, with rollback meaning a redeploy of the previous frontend build.

**What has to change** (scope, not design — the approach to several items is an open decision,
listed below):

1. **Move the data hooks out of `src/firebase/` first.** `useFirestore.js` and
   `useDepartments.js` are the app's data layer, not Firebase plumbing; `App.jsx` imports
   them. They need a new home (`src/hooks/` is the obvious one) before Phase 11 can delete
   the directory.
2. **Auth.** Replace `authService.js` (sign-in, sign-out, the auth-state listener, the
   password-setup email) and `authSessionService.js` (`verifyAuthSession`) with calls to
   `POST /auth/login`, `/auth/refresh`, `/auth/logout` and `/auth/set-password`; replace
   `useAuthSession.js`'s `onAuthStateChanged` with a restore-on-boot against the refresh
   cookie. Add whatever the session needs that the API does not yet return, and a
   set-password route in the app, which does not exist.
3. **One API client.** `firestoreService.js` is replaced by a single client module (base URL,
   bearer token, refresh on 401) plus per-resource service modules. The Firestore query
   descriptors, the 30-value `in`-query chunking and the per-role `get*ReadPlan` functions in
   `useFirestore.js` disappear, because the API scopes every read server-side.
4. **Replace `onSnapshot` with polling** ([D3](schema-design.md#d3--realtime-behavior-is-lost--settled-polling)),
   in `useAuthenticatedCollection.js`. It already carries a `refresh` / `refreshKey`
   mechanism. Points to get right: only the *first* load may set `loading` (`App.jsx` replaces
   the whole app with a loading screen whenever any collection is loading, so a background
   poll that flipped it would blank the page); one polling loop rather than eight independent
   timers; paused while the tab is hidden. **Blocked until
   [D20](schema-design.md#d20--agentsmd-1-still-forbids-the-polling-decision) is closed.**
5. **New service modules for the four domains that have none**: attendance, leaves, payroll
   and departments, whose writes today go from `useCollectionResource.js` straight to
   Firestore with a client-generated `id: Date.now()`. The API's strict schemas reject `id`,
   `status`, `days`, `gross`, `tax`, `net` and the like.
6. **Re-point the four callable-backed modules** (`employeeInvitationService.js`,
   `employeeMutationService.js`, `projectMutationService.js`, `kpiMutationService.js`).
   KPI rating moves from the update call to `POST /kpis/:id/rating`; employee delete needs a
   `replacement_team_lead_id` the UI has no way to supply.
7. **Delete what becomes redundant.** `scopedWorkspaceService.js`, `useScopedWorkspace.js` and
   the callable-backed branch in `useProjects` / `useKpis` (managers and TLs now read projects
   and KPIs directly — ambiguity A8); and the two modules with no importer,
   `authEmployeeVerificationService.js` and `legacyEmployeeLinkService.js`.
8. **Translate the data shape.** Every read returns relational snake_case (`full_name`,
   `position_title`, `department_id`, `employee_number`, `joined_on`, ...); the pages consume
   Firestore-shaped documents (`name`, `pos`, `dept`, `empId`, `joinDate`, ...), and the leave
   balance is a different shape altogether. The approach is an open decision
   ([D39](schema-design.md#d39--response-shape-and-leave-balance-presentation)). Since 2026-10-08
   the leave balance cards also become **usage cards** (days taken, with no total or remaining
   figure), because there are no entitlements
   ([D40](schema-design.md#d40--no-leave-entitlements-approval-is-the-only-control--settled)); what
   they show is an open question there.

**Known hazards found so far — a partial list.**

- **UUID ids vs numeric coercion — `src/pages/payroll/PayrollPage.jsx:24` and `:46`.** Both
  do `employees.find(e => e.id === +selEmp)`. The unary `+` turns the selected id into a
  number; Firestore ids were numeric strings, so it worked. API ids are UUIDs, so `+selEmp`
  is `NaN`, no employee is found, and payroll can neither be previewed nor processed. **This
  was found with a single family of grep patterns** (`+sel`, `+form.`, `+e.id`, `+emp`,
  `=== +`, `Number(…Id)`, `parseInt(…Id)`) run over `src/` **excluding** `src/firebase/` and
  `src/services/`. It found nothing else, but that is evidence about those patterns only.
  Other forms of the same assumption — numeric id variants (`getRelationshipIdVariants`,
  `Number.isSafeInteger` id checks in the service sanitizers, both of which are Firestore-era
  code), `String(a) === String(b)` comparisons, ids used as array indexes or sort keys, and
  anything in `Dashboard.jsx` and `ReportsPage.jsx`, which were not read closely — **have not
  been audited**. Treat the whole of `src/` as unaudited for this hazard until it has been
  read, not grepped.
- **Money columns on employees arrive as strings.** `employees.basic` and
  `employees.allowances` are `numeric`, selected without a cast, so `pg` returns strings
  ([D28](schema-design.md#d28--payroll-write-rules--settled) records this as a "known,
  separate fix"). `PayrollPage.jsx:26` computes `emp.basic + emp.allowances + +form.bonus`,
  which concatenates two strings before adding a number. The payroll preview cannot work
  until that is fixed.
- **Client-generated ids.** `LeavePage.jsx`, `PayrollPage.jsx`, `KPIPage.jsx` and the default
  of `useCollectionResource.create` all send `id: Date.now()`. The API's strict schemas
  reject `id`.
- **Department status casing.** `DepartmentsPage.jsx` writes and compares `"Active"`; the API
  enum is lowercase `active` / `inactive`.
- **Departments are identified by *name* in the pages** (`e.dept === dept.name`, 51
  occurrences of `.dept` outside `src/firebase/` and `src/services/`), while the API
  identifies them by id and only admin and hr can read the department list
  ([D33](schema-design.md#d33--department-names-for-manager-tl-and-employee)).

**Open decisions this phase cannot start without** (all recorded in
[schema-design.md §9](schema-design.md#9-decisions-i-need-from-you), none settled):

| Decision | Gates |
|---|---|
| [D20](schema-design.md#d20--agentsmd-1-still-forbids-the-polling-decision) `AGENTS.md` §1 vs polling | the polling work (item 4) |
| [D32](schema-design.md#d32--session-restore-and-the-frontends-own-profile) no session / profile endpoint | login and every page |
| [D33](schema-design.md#d33--department-names-for-manager-tl-and-employee) department names for manager, tl, employee | login, and every `.dept` use |
| [D34](schema-design.md#d34--delivering-the-password-setup-link-builds-on-d25) password-setup delivery | employee creation |
| [D35](schema-design.md#d35--employee-status-on-create) employee status on create | employee creation |
| [D36](schema-design.md#d36--production-cookie-topology) production cookie topology | login in production |
| [D37](schema-design.md#d37--the-role-selector-role_mismatch) the role selector | login |
| [D38](schema-design.md#d38--payroll-tax-client-preview-vs-the-database) payroll tax parity | the payroll page |
| [D39](schema-design.md#d39--response-shape-and-leave-balance-presentation) response shape and leave-balance presentation | every page |

**Depends on.** Phase 9 (done), D20 closed, and at least D32, D33, D34, D36 and D37 decided,
since together they gate login.

**Verified by.** A staged rehearsal on a copy: each of the five roles logs in through the UI,
sees the scope the API returns, and performs the role × operation matrix; a decision made by
one user appears for another within the polling interval; `npm run build` passes with the
Firebase code still present (it is removed only in Phase 11).

**Stays on Firebase.** Nothing at runtime once cut over. The Firebase code, rules, functions
and project remain in place until Phase 11.

---

## Phase 11 — Decommission Firebase

*Previously numbered Phase 10; renumbered 2026-10-07 when the frontend cutover was inserted
ahead of it.*

**Build.** Delete `functions/`, `firestore.rules`, `firebase.json` and `src/firebase/`; remove
the `firebase` dependency; remove `VITE_FIREBASE_*` from the environment; delete the dead
seeder `src/firebase/seedFirestore.js` (ambiguity A11 — it cannot run under current rules
anyway).

> **Prerequisite (added 2026-10-07): `src/firebase/` is not only Firebase.** Besides
> `firebaseConfig.js` and the dead seeder, it holds `useFirestore.js` and `useDepartments.js`
> — the hooks every page is fed through, imported by `App.jsx`. Deleting the directory as
> written above would delete the app's data layer. Those two files **must be moved out in
> Phase 10**, and this phase may delete `src/firebase/` only after a search of `src/` shows
> nothing outside that directory still imports from it.

**Depends on.** Phase 10, and Phases 4-9, all landed and stable for an agreed soak period.

**Verified by.** `npm run build` succeeds with no Firebase import anywhere; a full pass of the
role × operation matrix against the API only; Firestore access logs show zero reads for the
soak period **before** any deletion.

**Stays on Firebase.** Nothing. Keep the Firebase project itself in read-only suspension, not
deleted, until at least one full payroll cycle has run on Postgres.

> **Update (2026-09-21):** since there is no data migration, Firebase can be removed without
> any data-preservation step — no read-only suspension period, no soak-period access-log
> check for un-migrated data. The soak period above still applies for verifying the new
> Postgres-only system is stable before Firebase is deleted, just not for data preservation.

---

## Phase 12 — Announcements (deferred, not cancelled)

*Added 2026-10-08.*

**Build.** An announcements feature: an admin posts something that all employees see. **Nothing is
designed.** It would need somewhere to store announcements, endpoints to post and read them, and a
place for them in the frontend, along with the questions that come with any of those — none of which
has been asked yet.

**Why it is here and not earlier.** It is deferred until the Firebase migration is complete, so that it
is built once, on Postgres, with no Firebase version to migrate. **Deferred, not cancelled.**

**Depends on.** Phase 11. Independent of Phase 13.

---

## Phase 13 — UI and animation work (deferred, not cancelled)

*Added 2026-10-08.*

**Build.** The broader UI and animation work, beyond keeping the existing interface unchanged through
the migration. `AGENTS.md` §4 and §5 already set the design standard and the GSAP rules this would
follow. **Nothing is scoped here.**

**Why it is here and not earlier.** `AGENTS.md` §1 requires the existing frontend architecture and UI
behaviour to stay unchanged during any backend or database migration. The departures recorded so far are
the polling decision (D3, with the conflict still open as D20) and the usage cards (D40); this work is
deferred until the migration is complete so it does not compound them. **Deferred, not cancelled.**

**Depends on.** Phase 11. Independent of Phase 12.

---

## Dependency order at a glance

```
Phase 0  schema ──► 1 auth/scope ──► 2 ETL ──► 3 read API + parity
                                                      │
                                                      ▼
                                    4 identity + employees   ◄── blocked by D11
                                                      │
                    ┌────────────┬────────────┬───────┴──────┐
                    ▼            ▼            ▼              ▼
                 5 depts ──► 6 attendance ──► 7 payroll ──► 8 projects+kpis
                                                                │
                                                                ▼
                                                     9 leaves  ◄── was blocked by D4 (dissolved by D40; rework needed)
                                                                │
                                                                ▼
                                                     10 frontend cutover  ◄── blocked by D20, D32-D39
                                                                │
                                                                ▼
                                                     11 decommission
                                                                │
                                                                ▼
                                                     12 announcements, 13 UI and animation  (deferred)
```

Phases 5-8 are drawn sequentially because each is a separate cutover window, but they are
independent of one another and could be reordered or parallelised. Phase 9 is last by
necessity; Phase 4 must precede all of them because scope resolution depends on it.

Phases 0-9 are the **backend**; Phase 10 is the whole **frontend** cutover and is a single
window (see its note on why it cannot be per-domain); Phase 11 removes Firebase. Phases 12 and 13
are **deferred, not cancelled**: they come after the Firebase migration is complete, and are
independent of each other.

---

## Rollback posture

Each domain cutover is a flag flip in its `src/services/*.js` module. Rollback is reverting
the flag — **but any writes made to Postgres after the flip are not in Firestore.**

> **Correction (2026-10-07):** this describes the *backend* domains' data, not the frontend.
> No such flag exists in `src/services/` or the hooks, and none could work: Firestore requires
> a Firebase Auth identity, so once the browser logs in against Postgres it cannot reach
> Firestore at all. The frontend cuts over in one window ([Phase 10](#phase-10--frontend-cutover)),
> and its rollback is redeploying the previous frontend build. The caveat about writes made to
> Postgres after the cutover still applies.

The mitigation, sized to a single-company dataset: a brief freeze per domain, a final ETL
re-sync, then the flip. If rollback is needed within the window, the lost writes are few and
identifiable by `created_at`. Beyond that window, rollback requires a reverse-sync script that
does not exist and should not be written speculatively.

Phase 4 is the exception and cannot be cleanly rolled back, because passwords will have been
reset into Postgres and cannot be pushed back to Firebase Auth. **Treat Phase 4 as one-way**
and rehearse it fully on a copy first.

---

## Blockers that need answers before the phase they gate

| Decision | Gates | Why it blocks |
|---|---|---|
| ~~[D2](schema-design.md#d2--rewrite-001-or-add-002) rewrite `001` vs add `002`~~ | Phase 0 | **settled** — rewritten in place, no `002` |
| ~~[D1](schema-design.md#d1--soft-or-hard-delete) soft vs hard delete~~ | Phase 0 | **settled** — soft for employees/payroll/leaves, hard elsewhere |
| ~~[D3](schema-design.md#d3--realtime-behavior-is-lost--settled-polling) realtime loss~~ | Phase 3-4 | **settled** — polling; but see D20 below |
| ~~[D11](schema-design.md#d11--firebase-auth-passwords-cannot-be-exported) password migration~~ | Phase 4 | **settled (2026-09-21)** — moot, no data migration, no existing users |
| ~~[D4](schema-design.md#d4--where-do-leave-entitlements-come-from) leave entitlements~~ | Phase 9 | **dissolved (2026-10-08, [D40](schema-design.md#d40--no-leave-entitlements-approval-is-the-only-control--settled))** — there are no entitlements; a balance is now days taken |
| [D40](schema-design.md#d40--no-leave-entitlements-approval-is-the-only-control--settled) what "days taken" counts, and the usage view | the Phase 9 rework, then Phase 10's usage cards | open; Phase 9 as built is partly wrong (see Phase 9) and the endpoint's final meaning is undecided |
| [D20](schema-design.md#d20--agentsmd-1-still-forbids-the-polling-decision) `AGENTS.md` §1 conflict | Phase 3 (still open; now also gates Phase 10's polling work) | the rule still forbids what D3 decided |
| [D32](schema-design.md#d32--session-restore-and-the-frontends-own-profile)–[D39](schema-design.md#d39--response-shape-and-leave-balance-presentation) frontend cutover gaps | Phase 10 | all open; each is a gap between what the API provides and what the frontend needs — Phase 10 lists which gates what |

**D3 is settled as polling, but D20 is not.** The app is live-updating today via `onSnapshot`;
under polling it will not be. `AGENTS.md` §1 requires UI behavior to stay unchanged during the
migration, so the rules file and this plan now contradict each other in writing. `AGENTS.md`
has not been edited. Either it gains a carve-out for realtime during the migration, or the
departure is recorded as a knowing exception — but the contradiction should be closed before
Phase 3, not carried silently.

The full list of open decisions is
[schema-design.md §9](schema-design.md#9-decisions-i-need-from-you).
