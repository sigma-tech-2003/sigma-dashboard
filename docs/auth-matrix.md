# Authorization matrix

Captured from `migration/postgres` @ `2bab7c0`. Derived from `firestore.rules` (847 lines)
and the authorization checks inside `functions/`. Every claim carries a `file:line`
reference. This document describes **what is enforced today** and proposes no changes.

Companion document: [firebase-inventory.md](firebase-inventory.md).

---

## 0. There are two authorization systems, not one

This is the single most important fact for the Postgres rebuild.

| Collection | Writes allowed by rules? | Where write authorization actually lives |
|---|---|---|
| `employees` | **no** — `if false` (`firestore.rules:796`) | `functions/employeeMutationService.js` |
| `projects` | **no** — `if false` (`:808`) | `functions/projectMutationService.js` |
| `kpis` | **no** — `if false` (`:813`) | `functions/kpiMutationService.js` |
| `authLinks` | **no** — `if false` (`:791`) | Admin SDK only |
| `departments` | **yes**, admin only | `firestore.rules` alone |
| `leaves` | **yes** | `firestore.rules` alone |
| `attendance` | **yes** | `firestore.rules` alone |
| `payroll` | **yes** | `firestore.rules` alone |

So `leaves`, `attendance`, `payroll` and `departments` are written **directly from the
browser**, validated *only* by security rules — including the payroll tax arithmetic
(`firestore.rules:614-615`) and the leave day-count arithmetic (`:406-411`). Migrating them
means writing both the endpoint and the validation from scratch; there is no Cloud Function
to port.

Sections 2–3 cover the rules system. Section 4 covers the callable system.

---

## 1. Rules helper reference

Every rule is ultimately gated on `hasActiveEmployeeIdentity()`.

### Identity chain

| Function | Line | Checks |
|---|---|---|
| `isAuthenticated()` | 5-7 | `request.auth != null` |
| `authLinkPath()` | 9-11 | path to `authLinks/$(request.auth.uid)` |
| `employeePath(id)` | 13-15 | path to `employees/$(id)` |
| `isNonEmptyString(v, max)` | 17-21 | string, `0 < size <= max`; no character-class restriction |
| `isSafeDocumentId(v)` | 23-28 | non-empty ≤1500, not `.`/`..`, matches `^[^/]+$` — blocks path traversal |
| `isIsoTimestampString(v)` | 30-36 | exactly 24 chars, strict ISO-8601 with milliseconds |
| `isSafeNumericId(v)` | 38-43 | digits, no leading zeros, ≤16 chars, ≤ `MAX_SAFE_INTEGER` |
| `valueMatchesDocumentId(v, id)` | 45-55 | string equality **or** int equality — the legacy numeric-id bridge |
| `hasValidAuthLink()` | 57-78 | authLink exists with **exactly** `employeeId, createdAt, updatedAt`; id is safe; timestamps are non-empty strings ≤64 (see §5.1) |
| `currentEmployeeId()` | 80-82 | `get(authLinkPath()).data.employeeId` — unguarded accessor |
| `currentEmployeeData()` | 84-86 | `get(employeePath(currentEmployeeId())).data` — unguarded |
| **`hasActiveEmployeeIdentity()`** | **88-104** | valid authLink + employee exists + has `uid,status,role,dept` + `uid.trim() == request.auth.uid` (98) + `status.trim().lower() == 'active'` (100) + supported role + non-empty dept |
| `hasRole(role)` | 106-108 | active identity **and** `role == <exact string>` — note: **byte-exact**, unlike `status` |
| `isAdmin` / `isHr` / `isManager` / `isTeamLead` / `isEmployee` | 110-128 | `hasRole('admin' \| 'hr' \| 'manager' \| 'tl' \| 'employee')` |
| `isSupportedRole(role)` | 130-132 | `role in ['admin','hr','manager','tl','employee']` |

> **Three different normalization policies coexist in one predicate chain:** `uid` is
> trimmed (98), `status` is trimmed *and* lowercased (100), `role` is compared byte-exact
> (107). A role stored as `"Admin"` fails `isSupportedRole` at 102 and locks the user out
> entirely.

### Parallel identity chain for projects/KPIs

| Function | Line | Checks |
|---|---|---|
| `hasCanonicalProjectKpiIdentity()` | 134-150 | `hasActiveEmployeeIdentity()` plus re-verification of authLink keys, timestamps, employee keys and supported role |
| `hasSafeNumericLegacyEmployeeId()` | 152-154 | `isSafeNumericId(currentEmployeeId())` |
| `matchesCurrentEmployeeId(v)` | 156-169 | string or legacy-int match against `currentEmployeeId()` |
| `projectIsAssignedToCurrentEmployee(p)` | 171-181 | `assignedEmployeeIds` contains the caller, string or int form |
| `canReadProject(p)` | 183-190 | admin \| hr \| (employee && assigned). **Manager and TL absent → denied** |
| `canReadKpi(k)` | 192-203 | admin \| hr \| (employee && `matchesCurrentEmployeeId(k.empId)`). **Manager and TL denied** |

> **`hasCanonicalProjectKpiIdentity()` is entirely redundant** — every check it performs is
> already implied by `hasActiveEmployeeIdentity()` on line 135. See ambiguity A7.

### Employee scoping

| Function | Line | Checks |
|---|---|---|
| `hasEmployeeDepartment(e)` | 205-208 | non-empty `dept` ≤120 |
| `isAssignedToCurrentTeamLead(e)` | 210-213 | `e.teamLeadId` matches caller |
| `canReadEmployee(id, e)` | 215-234 | admin \| hr \| (manager && same dept) \| (tl && (self \| reports to caller)) \| (employee && self) |

### Canonical employee reference — `leaves` / `attendance`

| Function | Line | Checks |
|---|---|---|
| `hasCanonicalEmployeeReference(r)` | 277-281 | `r.empId` present, safe doc id, **and the referenced employee exists** |
| `referencedEmployeeData(r)` | 283-285 | unguarded `get()` |
| `referencedEmployeeHasDepartment(r)` | 287-290 | non-empty dept ≤120 |
| `referencedEmployeeIsActive(r)` | 292-296 | `status == 'active'` — **byte-exact, no trim, no lower** (contrast line 100) |
| `referencedEmployeeIsOnCurrentTeam(r)` | 298-302 | referenced employee's `teamLeadId == currentEmployeeId()` |
| `canReadCanonicalEmployeeRecord(r)` | 304-329 | admin \| hr \| (manager && ref && same dept) \| (tl && ref && (self \| team)) \| (employee && ref && self). **Admin/HR branches carry no reference check** — see §5.3 |
| `canManageCanonicalEmployeeRecord(r)` | 331-343 | blanket `hasCanonicalEmployeeReference` **retained**, then admin \| hr \| (manager && same dept). **TL and employee denied** |
| `canApproveCanonicalEmployeeLeave(r)` | 345-362 | as above, plus TL branch requiring `r.empId != currentEmployeeId()` (358) — **a TL may approve team members' leave but explicitly not their own** |

### Validators

| Function | Line | Enforces |
|---|---|---|
| `isValidCalendarDate` | 236-256 | `YYYY-MM-DD` **and** round-trips through `timestamp.date()`, so `2026-02-30` is rejected |
| `isValidIsoDateTime` | 266-275 | strict ISO plus hour/minute/second ranges |
| `leaveHasValidFields` | 368-418 | exactly 9 keys; type in `Annual\|Sick\|Casual\|Maternity\|Emergency`; `start <= end`; **`days` exactly equals the inclusive day count** (406-411); reason ≤2000 non-blank; status in `pending\|approved\|rejected` |
| `attendanceHasValidFields` | 448-496 | exactly 9 keys; `date` **not in the future**; status in `present\|absent\|late\|leave`; `checkOut > checkIn`; `absent`/`leave` forces empty times; `createdAt <= updatedAt` |
| `calculatedPayrollTax(gross)` | 549-559 | progressive brackets: 0 to 50k; 5% to 100k; 2500 + 10% to 200k; 12500 + 15% beyond |
| `payrollHasValidFields` | 561-618 | exactly 11 keys; **`tax` must equal the computed bracket** (614); **`net == gross - deductions - tax`** (615); status in `draft\|processed` |
| `leaveBalanceBucketHasValidFields` | 660-669 | map of exactly `t,u,r`; non-negative ints; `u <= t`; **`r == t - u`** |
| `departmentHasValidFields` | 725-765 | required `id,name,status,createdAt`; status in `'Active'\|'Inactive'` (title case); `createdAt` strict ISO |

---

## 2. Per-collection allow rules

Quoted from `firestore.rules:790-845`. **An operation not listed for a collection is
denied** — Firestore defaults to deny, and the catch-all `match /{document=**}` at 843-845
is `allow read, write: if false`.

```
authLinks/{uid}          allow read, write: if false;                              (791)

employees/{employeeId}   allow read:   if canReadEmployee(employeeId, resource.data);  (795)
                         allow create, update, delete: if false;                       (796)

departments/{id}         allow read:   if isAdmin() || isHr();                     (800)
                         allow create: if canCreateDepartment(id);                 (801)
                         allow update: if canUpdateDepartment(id);                 (802)
                         allow delete: if canDeleteDepartment(id);                 (803)

projects/{projectId}     allow read:   if canReadProject(resource.data);           (807)
                         allow create, update, delete: if false;                   (808)

kpis/{kpiId}             allow read:   if canReadKpi(resource.data);               (812)
                         allow create, update, delete: if false;                   (813)

leaves/{leaveId}         allow read:   if canReadCanonicalEmployeeRecord(...);     (817)
                         allow create: if canCreateLeave(leaveId);                 (818)
                         allow update: if canUpdateLeave(leaveId);                 (819)
                         allow delete: if false;                                   (820)

attendance/{id}          allow read:   if canReadCanonicalEmployeeRecord(...);     (824)
                         allow create: if canCreateAttendance(id);                 (825)
                         allow update: if canUpdateAttendance(id);                 (826)
                         allow delete: if canDeleteAttendance(id);                 (827)

payroll/{payrollId}      allow read:   if canReadPayroll(payrollId, ...);          (831)
                         allow create: if canCreatePayroll(payrollId);             (832)
                         allow update: if canUpdatePayroll(payrollId);             (833)
                         allow delete: if canDeletePayroll(payrollId);             (834)

leaveBalances/{empId}    allow get:    if canReadLeaveBalance(empId, ...);         (838)
                         allow list, create, update, delete: if false;             (839)

{document=**}            allow read, write: if false;                              (844)
```

`leaveBalances` is the **only** collection that splits `get` from `list`. Everywhere else
`read` covers both, so a list query is evaluated per returned document and the *entire query*
fails unless the client pre-scopes it — which is why `src/firebase/useFirestore.js` builds
explicit per-role read plans.

Line 842 carries the comment `// Remaining collection rules must be added before these rules
are deployed.` — see ambiguity A9.

---

## 3. Role × collection × operation matrix

Every cell is implicitly gated on `hasActiveEmployeeIdentity()` (88-104).
**Unauthenticated is denied in every cell** — `isAuthenticated()` fails, every predicate
short-circuits, and the catch-all covers anything unmatched.

| Collection / Op | admin | hr | manager | tl | employee |
|---|---|---|---|---|---|
| **authLinks** — all | denied | denied | denied | denied | denied |
| **employees** read | allowed | allowed | same `dept` as caller (221-224) | self, or `teamLeadId` == caller (226-231) | self only (232) |
| **employees** create/update/delete | denied | denied | denied | denied | denied |
| **departments** read | allowed | allowed | denied | denied | denied |
| **departments** create | valid fields, no `_docId` (767-770) | **denied** | denied | denied | denied |
| **departments** update | only `name/description/managerId/status/_docId` may change (772-783) | **denied** | denied | denied | denied |
| **departments** delete | stored doc must validate (785-788) | **denied** | denied | denied | denied |
| **projects** read | allowed | allowed | **denied** | **denied** | assigned to caller (171-181) |
| **projects** create/update/delete | denied | denied | denied | denied | denied |
| **kpis** read | allowed | allowed | **denied** | **denied** | own `empId` (200) |
| **kpis** create/update/delete | denied | denied | denied | denied | denied |
| **leaves** read | allowed, no reference check (§5.3) | allowed, same | referenced employee exists and shares dept (310-314) | own, or employee on caller's team (315-322) | own `empId` (323-327) |
| **leaves** create | **denied** | **denied** | **denied** | **denied** | own `empId`, `status=='pending'`, `applied == today` (420-426) |
| **leaves** update | `pending` → `approved`/`rejected`, only `status` changes (428-438) | same | same + dept-scoped (351-355) | same + on caller's team **and not self** (356-360) | **denied** |
| **leaves** delete | **denied** | denied | denied | denied | denied |
| **attendance** read | allowed | allowed | referenced employee shares dept | self or own team | own `empId` |
| **attendance** create | referenced employee active (strict), `createdAt==updatedAt`, dated today (502-510) | same | same + dept-scoped (337-341) | **denied** | **denied** |
| **attendance** update | manage rights on old **and** new; `createdAt`/`id` frozen; `updatedAt` strictly increasing and today (512-531) | same | same + dept-scoped | **denied** | **denied** |
| **attendance** delete | stored doc must validate (533-536) | same | same + dept-scoped | **denied** | **denied** |
| **payroll** read | stored doc must validate, incl. tax/net arithmetic (620-632) | same | **denied** | **denied** | own `empId` **and** `status == 'processed'` (626-630) |
| **payroll** create | `status == 'processed'` required (634-638) | same | denied | denied | denied |
| **payroll** update | `draft` → `processed` only, only `status` changes (640-649) | same | denied | denied | denied |
| **payroll** delete | stored doc must validate (651-654) | same | denied | denied | denied |
| **leaveBalances** get | **denied** | **denied** | **denied** | **denied** | self only (687-691) |
| **leaveBalances** list/create/update/delete | denied | denied | denied | denied | denied |
| **anything else** | denied | denied | denied | denied | denied |

Two cells worth calling out because they invert the usual pattern:

- **`leaveBalances`: only `employee` can read, admin and HR cannot.** (`:687-691`)
- **`departments`: HR can read but every HR write is denied** — the read rule at 800 includes
  HR, all three write rules require `isAdmin()` only (768, 773, 786). See ambiguity A4.

---

## 4. Callable authorization — the second system

These checks live in `functions/` and are the *only* authorization for `employees`,
`projects` and `kpis` writes, which rules deny outright.

| Gate | Where | Effect |
|---|---|---|
| `MANAGING_ROLES = {admin, hr, manager, tl}` | `projectMutationService.js:36`, `kpiMutationService.js:6` | `employee` cannot mutate projects or KPIs |
| Scoped-workspace allowlist `{manager, tl}` | `scopedWorkspaceService.js:214-220` | **admin, HR and employee are denied** this endpoint |
| `ROLE_ASSIGNMENTS` hierarchy | `employeeMutationService.js:28-34` | admin→all; hr→`{manager,tl,employee}`; manager→`{tl,employee}`; tl→`{employee}`; employee→none |
| `PAYROLL_ROLES = {admin, hr}` | `employeeMutationService.js:35`, enforced `:452-463` | **only admin and HR may change `basic` or `allowances`** → `COMPENSATION_CHANGE_DENIED` |
| `SELF_DELETE_DENIED` | `employeeMutationService.js:418-420` | nobody may delete their own employee record |
| `SELF_ROLE_CHANGE_DENIED` | `employeeMutationService.js:426-428` | nobody may change their own role |
| Manager/TL cannot delete employees at all | `employeeMutationService.js:421-423` | only admin and HR reach a delete branch |
| TL update scope | `employeeMutationService.js:439-447` | target and candidate must both be `employee`, same dept, `teamLeadId == principal.id` **before and after** |
| `SELF_RATING_DENIED` | `kpiMutationService.js:616-618` | nobody may rate their own KPI |
| `LEGACY_RATING_NOT_ALLOWED` | `kpiMutationService.js:621-627` | KPIs with no `projectId` cannot be rated |
| `ROLE_MISMATCH` | `authSessionVerificationService.js:369-375` | the stored role must exactly equal the role selected at login |
| Optimistic concurrency | `employeeMutationService.js:541-557` | `identityVersion` over `{uid,email,status,role,dept,teamLeadId,updatedAt}` → `EMPLOYEE_TRANSACTION_CONFLICT` |
| Field denylists | `employeeMutationService.js:21-26`, `projectMutationService.js:21-34`, `kpiMutationService.js:26-44`, `employeeInvitationPolicy.js:26-53` | `password`, `uid`, `empId`, `createdAt`, `claims`, `customClaims`, `isAdmin` and more are rejected before any allowlist check |

**All of it is currently unenforced on the Postgres side** — see §6.

---

## 5. Recently relaxed rules

`firestore.rules` has two commits: `00c5e4e` created it, and **`334e4d9` is the only
modification**.

> ### Correction to this repository's own git history
>
> Commit `334e4d9` is titled **"Tighten Firestore authorization and scope verifyAuthSession
> CORS"**. That title is accurate only for the CORS half. **All three of its `firestore.rules`
> changes are relaxations, not tightenings**, and the commit message describes at least one of
> them as a fix. Anyone reading `git log` will form the opposite impression of the security
> posture from what the diff actually does.
>
> Nothing here necessarily needs reverting — the changes may be correct — but the record
> should be corrected.

### 5.1 `authLinks` timestamps: strict ISO → any non-empty string

Was `isIsoTimestampString(...)` on `createdAt` and `updatedAt`; now
`isNonEmptyString(..., 64)` at `firestore.rules:76-77`.

**Implication: low direct risk, real loss of defense-in-depth.** The justification in the
inline comment (73-75) is sound as far as it goes — `authLinks` is `allow read, write: if
false` (791), so no client can ever write one, and the Admin SDK bypasses rules entirely.
The format check was never an attacker-facing boundary.

What is lost is a *canary*. Any 1–64 character string now establishes identity — `"x"`,
`"0"`, `"null"`. A migration script or backfill that writes a placeholder can silently mint
a working identity and rules will not reject it. Note also that
`hasCanonicalProjectKpiIdentity()` (141-144) **already** accepted non-empty strings, so the
file was internally inconsistent beforehand; this commit resolved that inconsistency by
relaxing the strict side rather than tightening the loose side.

`isIsoTimestampString` is now used only by `isValidIsoDateTime` (267) and
`departmentHasValidFields` (764).

### 5.2 `uid.trim()` and `status.trim().lower()`

Was byte-exact `uid == request.auth.uid` and `status == 'active'`; now `uid.trim() == ...`
(98) and `status.trim().lower() == 'active'` (100).

**`uid.trim()`** — Firebase UIDs never contain whitespace, so this only widens what *stored*
values are accepted. It desynchronizes rules from the client's duplicate detection:
`findEmployeeByUid` (`src/services/firestoreService.js:443-455`) queries
`where("uid","==",normalizedUid)` with an exactly-trimmed value and throws
`EmployeeUidDataIntegrityError` when two documents match. A record stored as `" abc123"` is
**invisible** to that query but **accepted** by line 98. The invariant "one employee record
per auth account" is no longer the invariant rules enforce. Not directly exploitable — which
record is used is decided by `authLinks.employeeId`, which is Admin-SDK-controlled — but it
is a latent privilege-confusion hazard the previous comparison foreclosed.

**`status.trim().lower()`** — the more consequential of the two, because
`referencedEmployeeIsActive()` at 292-296 was **not** given the same treatment and remains
byte-exact. So an employee stored as `"Active"`:
- **can** authenticate and act (passes line 100)
- **cannot** be the subject of an attendance create or update (fails line 295 via `:504`, `:515`)

That is a split-brain definition of "active" inside one file. Deactivation also becomes
case-sensitive in the wrong direction: a flow writing `"ACTIVE"` or `" active"` leaves the
account fully live. The narrow mitigation is that the value must lowercase to exactly
`active`, so `"inactive"` and `"active-pending"` still fail.

### 5.3 `hasCanonicalEmployeeReference` demoted to per-branch

Was a blanket precondition in `canReadCanonicalEmployeeRecord`; now repeated inside the
manager (311), TL (317) and employee (325) branches and **absent** from `isAdmin()` (307) and
`isHr()` (308).

**Implication: read-only, and arguably the intended fix.** This function guards `leaves` read
(817) and `attendance` read (824) only. The write-side equivalents
`canManageCanonicalEmployeeRecord` (332) and `canApproveCanonicalEmployeeLeave` (347) both
**retain** the blanket precondition, so **no write path was weakened.**

For reads, admin and HR can now see leave and attendance records whose `empId` is missing,
malformed, or points at a deleted employee. They could already read every *well-formed*
record, so this grants access to orphaned and malformed rows only. That is plausibly
desirable: `/leaves` has `allow delete: if false` (820), so deleting an employee previously
made their leave history permanently unreadable **and** unremovable by anyone.

There is also a cost motivation: `hasCanonicalEmployeeReference` performs an `exists()` and
`referencedEmployeeData` a `get()`, both billed and limited per returned document on list
queries — and admin/HR are the only roles issuing unscoped collection listens
(`src/firebase/useFirestore.js:133`). Legitimate, but not what the commit message says.

---

## 6. Postgres gap analysis

`backend/src/` currently enforces **no authorization at all**. `GET /api/v1/health` is the
entire API surface (`backend/src/app.js:26`), and `middleware/authentication.js` is an
unmounted factory requiring a `verifyAccessToken` that does not exist.

### Collections

| Firestore collection | Postgres table | Gap |
|---|---|---|
| `employees` | `employees` | partial — see field gaps |
| `departments` | `departments` | partial |
| `authLinks` | none | conceptually replaced by `users.id` + `employees.user_id`; no session/token table exists |
| `projects` | **none** | no table |
| `kpis` | **none** | no table |
| `leaves` | **none** | no table |
| `attendance` | **none** | no table |
| `payroll` | **none** | no table |
| `leaveBalances` | **none** | no table |

**Six of nine business collections have no Postgres representation.** Conversely `companies`
and `teams` exist in Postgres with **no Firestore counterpart** — `companies` introduces
multi-tenancy that does not exist in Firestore at all, and `teams` promotes the
`employees.teamLeadId` self-pointer to a first-class entity.

### Rules with no Postgres equivalent

Every one of them. Specifically, nothing in `backend/` implements:
- the identity chain (`hasActiveEmployeeIdentity`, `canReadEmployee`, `canReadCanonicalEmployeeRecord`)
- payroll tax recomputation (`firestore.rules:545-559`) or the `net` invariant (`:615`)
- leave inclusive day-count arithmetic (`:406-411`)
- leave-balance `r == t - u` invariant (`:660-669`)
- attendance temporal checks — no future dates, `createdAt <= updatedAt`, `updatedAt` today (`:498-531`)
- any of the callable gates in §4, including the compensation gate and the self-rating ban

`employeeScopeService.getEmployeeScope` (`backend/src/services/employeeScopeService.js:7-17`)
returns a scope *descriptor* — `company` / `department` / `team` / `self` — but nothing
consumes it and there is no `WHERE`-clause builder. It is the seed of the scoping system, not
an implementation of it.

### Field-level gaps in the two tables that do exist

| Firestore | Postgres | Note |
|---|---|---|
| `employees.name` | `first_name` + `last_name`, both NOT NULL | **no split rule exists anywhere** |
| `employees.basic`, `.allowances` | **no columns** | compensation absent from the schema entirely |
| `employees.role` | `users.role` | role moves to a different table; every rules check reads `employees.role` (`firestore.rules:107`), so Postgres requires a join |
| `employees.status` (`active\|inactive`) | `users.status` (`account_status`) **and** `employees.employment_status` | two enums with extra values (`invited`, `suspended`, `on_leave`, `terminated`); no mapping defined |
| `employees.dept` → `departments.name` | `department_id uuid` | Firestore joins **by name**; ETL must resolve every string to a uuid |
| `employees.teamLeadId` | `team_id` + `teams.team_lead_employee_id` | requires synthesizing team rows that do not exist in Firestore |
| `employees.empId` (`EMP-<uid>`) | `employee_number varchar(64)` | roughly equivalent |
| `employees.createdByUid` | no column | currently written but never read |
| `departments.status` `'Active'\|'Inactive'` | `account_status` lowercase | case-folding step implied but unwritten |

---

## 7. Ambiguities — reported, not resolved

**A1 — `kpis.status` allows only `"active"`.** `kpiMutationService.js:7`. Cannot tell whether
KPI status is vestigial or this is a gap. Pre-existing documents with another status would
fail validation on any subsequent update. Verify against `src/pages/kpi/` before writing a
Postgres CHECK constraint.

**A2 — `leaveBalances` is read but never written, and never decremented.** Only writer is the
dead seeder `src/firebase/seedFirestore.js:34-36`. Leave approval never touches it, so `u`
and `r` are permanently stale. Unclear whether balances are meant to be computed from
`leaves` or maintained independently.

**A3 — `linkLegacyEmployeeUid` has no frontend caller.** The client wrapper exists
(`src/services/legacyEmployeeLinkService.js:55`) but nothing imports it. The logic still runs
server-side inside `verifyAuthSession`. Unclear whether the public endpoint should be ported.

**A4 — HR can read `departments` but every HR write is denied.** Read rule 800 includes HR;
write rules 768, 773, 786 require `isAdmin()`. Meanwhile `src/firebase/useDepartments.js:18`
mounts the write helpers for HR *and* admin, so HR sees department buttons that always fail.
Unclear which side is wrong.

**A5 — the payroll `draft` state is unreachable.** `canCreatePayroll` forces
`status == 'processed'` (637), the frontend is the only creator, and `canUpdatePayroll` only
permits `draft` → `processed` (644-645). So the update path at 640-649 can never fire. Either
drafts are meant to be seeded by something that does not exist, or the create rule should
permit `draft`.

**A6 — validators are applied on *read*.** `canReadPayroll` calls `payrollHasValidFields`
(622); `canReadLeaveBalance` calls `leaveBalanceHasValidFields` (690). A payroll row whose
`net` is off by one cent becomes **unreadable by everyone including admin**, indistinguishable
in the UI from "no data". The same pattern in `canDeleteAttendance` (534), `canDeletePayroll`
(653) and `canDeleteDepartment` (787) means **a malformed document can never be deleted** —
the only cleanup path is blocked by the corruption itself. Cannot tell whether this is
deliberate ("hide corrupt data") or accidental reuse of the write validator.

**A7 — `hasCanonicalProjectKpiIdentity()` (134-150) is fully redundant.** Every check is
implied by `hasActiveEmployeeIdentity()` on line 135. It exists only for `/projects` and
`/kpis`. No explanation in the file.

**A8 — manager and TL have zero rules access to `/projects` and `/kpis`** (183-190, 192-203)
while employees can read their own. The frontend routes them to `getScopedWorkspace` instead
(`src/firebase/useFirestore.js:233-235,257-259`), so this is intentional — but a manager can
read their department's *employees* yet not those employees' *KPIs* through rules, and the
reason for splitting the enforcement boundary at exactly these two collections is undocumented.

**A9 — line 842 says the rule set is incomplete.** `// Remaining collection rules must be
added before these rules are deployed.` All nine collections in use are covered, and
`canonicalRelationshipMigration.js:4-14` enumerates the same nine, so the comment may simply
be stale. Cannot determine what "remaining" refers to.

**A10 — client-exposed actions that rules always deny.** Not security holes (rules win) but
broken UX paths: `addLeave` is exposed to every role (`src/firebase/useFirestore.js:684`) but
`canCreateLeave` requires `isEmployee()` (421), so an admin applying for their own leave is
always denied; `addAttendance`/`updateAttendance`/`deleteAttendance` are exposed
unconditionally (`:660-662`) but TL and employee always fail.

**A11 — `src/firebase/seedFirestore.js` cannot run.** It writes to `employees`, `kpis`,
`leaves`, `payroll` and `leaveBalances`; under current rules every one of those writes is
denied. Its own header says "Run this ONCE … then remove it".

**A12 — `companies` and `teams` have no Firestore source.** Unclear whether a single default
company row is intended or multi-tenancy is a genuine new requirement, and whether teams
should be derived one-per-TL from `employees.teamLeadId` or modelled independently.

**A13 — `.down.sql` is unreachable.** `backend/src/db/migrator.js:4` matches only
`*.up.sql`, so `001_initial_core_hr_hierarchy.down.sql` is never executed by any code path.
Either intentional (down migrations run by hand) or a gap; the code gives no indication.
