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
3. **The seam is `src/services/*.js`.** Those modules already isolate every Firestore call
   from every component (`AGENTS.md` §2 requires it). Cutover swaps their implementation and
   touches no page or component — which is what keeps "existing frontend architecture
   unchanged" true.
4. **Smallest blast radius first.** Domains cut over in ascending order of coupling, so early
   mistakes are cheap.
5. **No dual-write.** Single company, small dataset — a brief per-domain freeze plus a final
   re-sync is simpler and more honest than a dual-write layer nobody will maintain. See
   [Rollback](#rollback-posture).

---

## Phase 0 — Reconcile the schema

**Build.** Bring `001_initial_core_hr_hierarchy.up.sql` in line with
[schema-design.md](schema-design.md): `full_name` replaces `first_name`/`last_name`, the
`teams` table and `employees.team_id` are removed in favour of `employees.team_lead_id`,
compensation columns are added, `companies` gets its singleton index, and the six missing
tables plus `payroll_tax_for()` are created.

**Depends on.** [D2](schema-design.md#d2--rewrite-001-or-add-002) — rewrite `001` or add
`002`. Also [D1](schema-design.md#d1--soft-or-hard-delete) (soft vs hard delete), because it
determines whether the partial unique indexes are required or merely harmless.

**Verified by.** `npm run db:validate`; `npm test` extended to assert every table, enum and
generated column exists; applying the migration to a scratch database and confirming
`payroll_tax_for()` reproduces the bracket table at `firestore.rules:549-559` exactly,
including rounding. **Do not run `db:migrate` against anything but a scratch database.**

**Stays on Firebase.** Everything. No user-visible change.

---

## Phase 1 — Backend foundation: identity, principal, scope

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
on `users`), [D10](schema-design.md#d10--session-strategy) (stateless JWT vs refresh tokens),
[D14](schema-design.md#d14--row-level-security) (RLS or service-layer scoping).

**Verified by.** Unit tests for the scope predicate covering all five roles; integration tests
asserting every role × collection × operation cell in
[auth-matrix.md §3](auth-matrix.md#3-role--collection--operation-matrix) either matches
Firestore or differs *deliberately* per the decisions. That matrix is the test oracle — this
is the phase where writing it pays off.

**Stays on Firebase.** Everything. Auth exists in Postgres but nothing uses it.

---

## Phase 2 — ETL: Firestore → Postgres

**Build.** A one-way, idempotent importer, modelled on the safety rails already proven in
`functions/canonicalRelationshipMigration.js`: dry-run by default, `--apply` requiring an
explicit project confirmation, refusal to proceed with any unresolved conflict, and a written
plan before any write ([firebase-inventory.md §6](firebase-inventory.md#6-canonicalrelationshipmigrationjs)).

Transformations it must perform, each already identified:
- seed exactly one `companies` row
- `employees.dept` (a department **name**) → `department_id` uuid
- `employees.name` → `full_name` (no split needed — that is why the decision matters)
- split each employee into a `users` row (email, role, status) and an `employees` row
- `authLinks.employeeId` → `employees.user_id`, enforcing the bijection that
  `canonicalRelationshipMigration.js:356-393` validates at runtime
- `projects.assignedEmployeeIds[]` → `project_assignments` rows
- `departments.status` `'Active'` → `'active'`; `payroll.month` name → `1-12`;
  attendance `""` times → `NULL`
- resolve the string-vs-integer legacy id tolerance
  ([firebase-inventory.md §4.2](firebase-inventory.md#42-string-vs-integer-id-tolerance)) once
  and for all — Postgres uuids admit no such ambiguity

**Depends on.** Phases 0-1. [D17](schema-design.md#d17--employee_number-generation)
(`employee_number` generation), [D9](schema-design.md#d9--attendance-uniqueness) — the importer
will **fail loudly on duplicate attendance rows**, which is the intended way to discover them.

**Verified by.** Row counts per collection versus per table; referential integrity (zero
orphaned `employee_id`); recomputing `payroll.tax`/`net` from imported inputs and diffing
against the Firestore values — **any mismatch here is a pre-existing corrupt row**, exactly
the class that ambiguity A6 made invisible; re-running the import and asserting zero changes.

**Stays on Firebase.** Everything. Postgres is a shadow copy, read by nothing.

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

**Verified by.** A staged rehearsal on a copy: every role logs in, sees the correct scope,
and the amended deletion authority behaves as specified — including that a TL delete without a
valid replacement is **rejected by the database**, not merely by the service. Confirm
`ROLE_MISMATCH` behavior (`authSessionVerificationService.js:369-375`) is preserved or
deliberately dropped.

**Stays on Firebase.** `projects`, `kpis`, `leaves`, `attendance`, `payroll`, `departments` —
all still read and written through Firestore. **This is the phase where both systems are live
at once**, so employees data is authoritative in Postgres while the rest still reads Firestore
employee documents. Keep the ETL running one-way for those collections until each cuts over.

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

**Depends on.** Phase 5. [D9](schema-design.md#d9--attendance-uniqueness).

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

**Stays on Firebase.** Nothing. This is the last domain.

---

## Phase 10 — Decommission Firebase

**Build.** Delete `functions/`, `firestore.rules`, `firebase.json` and `src/firebase/`; remove
the `firebase` dependency; remove `VITE_FIREBASE_*` from the environment; delete the dead
seeder `src/firebase/seedFirestore.js` (ambiguity A11 — it cannot run under current rules
anyway).

**Depends on.** Phases 4-9 all landed and stable for an agreed soak period.

**Verified by.** `npm run build` succeeds with no Firebase import anywhere; a full pass of the
role × operation matrix against the API only; Firestore access logs show zero reads for the
soak period **before** any deletion.

**Stays on Firebase.** Nothing. Keep the Firebase project itself in read-only suspension, not
deleted, until at least one full payroll cycle has run on Postgres.

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
                                                     9 leaves  ◄── blocked by D4
                                                                │
                                                                ▼
                                                     10 decommission
```

Phases 5-8 are drawn sequentially because each is a separate cutover window, but they are
independent of one another and could be reordered or parallelised. Phase 9 is last by
necessity; Phase 4 must precede all of them because scope resolution depends on it.

---

## Rollback posture

Each domain cutover is a flag flip in its `src/services/*.js` module. Rollback is reverting
the flag — **but any writes made to Postgres after the flip are not in Firestore.**

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
| [D2](schema-design.md#d2--rewrite-001-or-add-002) rewrite `001` vs add `002` | Phase 0 | cannot write the migration without it |
| [D1](schema-design.md#d1--soft-or-hard-delete) soft vs hard delete | Phase 0 | determines index and FK shape |
| [D11](schema-design.md#d11--firebase-auth-passwords-cannot-be-exported) password migration | Phase 4 | user-visible operational event needing scheduling |
| [D4](schema-design.md#d4--where-do-leave-entitlements-come-from) leave entitlements | Phase 9 | balances are uncomputable without it |
| [D3](schema-design.md#d3--realtime-behavior-is-lost-and-agentsmd-forbids-that) realtime loss | Phase 3-4 | REST replaces `onSnapshot`; `AGENTS.md` §1 forbids UI behavior change as written |

**D3 deserves emphasis.** The app is live-updating today: approve a leave and every open
dashboard reflects it immediately. REST does not do that. `AGENTS.md` §1 requires UI behavior
to stay unchanged during the migration, so this is a genuine conflict between a settled
architectural rule and the plan — resolvable by accepting polling, building SSE/WebSockets, or
amending the rule, but **not by ignoring it.** It should be decided before Phase 3 rather than
discovered during Phase 4.

The full list of open decisions is
[schema-design.md §9](schema-design.md#9-decisions-i-need-from-you).
