import assert from "node:assert/strict";
import test from "node:test";
import { createLeaveMutationService } from "../src/services/leaveMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { LEAVE_TYPES } from "../src/utils/leaveTypes.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. A fake repository stands in for leaveRepository and runs the service's `validate`
// callback the way the real one does, so the orchestration -- gate, then the callback's refusal,
// then the write -- is exercised. The authorization matrix is leaveAuthorization.test.js; the SQL is
// leaveRepository.test.js; the real locks and constraints are scripts/e2e-leaves.js.
//
// D40: there are no entitlements and no limits. The only thing that can refuse an application is the
// overlap check, and the tests below say so in both directions -- the refusal, and the absence of any
// other.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const TL = "tl-1";
const EMPLOYEE = "emp-1";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id", employeeId: role === "tl" ? TL : "principal-emp", role, departmentId: DEPARTMENT, ...overrides,
});

/** A leave as findByIdForWrite returns it. */
const leave = (overrides = {}) => ({
  id: "leave-1", employee_id: EMPLOYEE, status: "pending",
  employee_department_id: DEPARTMENT, employee_team_lead_id: TL, ...overrides,
});

function fakeRepository({ overlapping = [], leaves = [], decideResult, decideError } = {}) {
  const byId = new Map(leaves.map((row) => [row.id, row]));
  const calls = { create: [], findByIdForWrite: [], decide: [], deleteById: [] };
  return {
    calls,
    async create(input, validate) {
      // Exactly what the real create hands the service: the overlapping leaves, and nothing else.
      await validate({ overlapping });
      calls.create.push(input);
      return { id: "new-leave", ...input, status: "pending" };
    },
    async findByIdForWrite(id) {
      calls.findByIdForWrite.push(id);
      return byId.get(id) ?? null;
    },
    async decide(id, decision) {
      calls.decide.push({ id, ...decision });
      if (decideError) throw decideError;
      return decideResult === undefined ? { id, status: decision.status } : decideResult;
    },
    async deleteById(id, deletedBy, mode) {
      calls.deleteById.push({ id, deletedBy, mode });
    },
  };
}

const FIXED_NOW = () => new Date("2026-03-04T10:00:00Z");
const serviceFor = (repository, options = {}) =>
  createLeaveMutationService({ leaveRepository: repository, timeZone: "Asia/Karachi", now: FIXED_NOW, ...options });

const APPLY = Object.freeze({ type: "Annual", start_date: "2026-03-10", end_date: "2026-03-11", reason: "Family" });

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

// ---------------------------------------------------------------------------
// applyLeave
// ---------------------------------------------------------------------------

test("applyLeave: every role may apply, and the applicant is always the acting principal", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeRepository();
    const principal = principalFor(role);

    const result = await serviceFor(repository).applyLeave(principal, APPLY);

    assert.equal(repository.calls.create.length, 1, role);
    assert.equal(repository.calls.create[0].employee_id, principal.employeeId, role);
    assert.equal(result.status, "pending", role);
  }
});

test("applyLeave: an account with no employee record is refused before the repository is touched", async () => {
  const repository = fakeRepository();
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("admin", { employeeId: null }), APPLY));

  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "role_not_allowed");
  assert.equal(repository.calls.create.length, 0);
});

test("applyLeave: applied_on is the server's -- today in the COMPANY timezone, not UTC's", async () => {
  // 20:00 UTC on 4 March is already 5 March in Karachi (UTC+5).
  const repository = fakeRepository();
  const late = () => new Date("2026-03-04T20:00:00Z");

  await serviceFor(repository, { now: late }).applyLeave(principalFor("employee"), APPLY);
  assert.equal(repository.calls.create[0].applied_on, "2026-03-05");

  const utcRepository = fakeRepository();
  await serviceFor(utcRepository, { now: late, timeZone: "UTC" }).applyLeave(principalFor("employee"), APPLY);
  assert.equal(utcRepository.calls.create[0].applied_on, "2026-03-04");
});

test("applyLeave: passes only the five application fields -- nothing client-supplied can reach status, days or a decision", async () => {
  const repository = fakeRepository();
  await serviceFor(repository).applyLeave(principalFor("employee"), { ...APPLY, status: "approved", days: 99, employee_id: "victim" });

  assert.deepEqual(Object.keys(repository.calls.create[0]).sort(), [
    "applied_on", "employee_id", "end_date", "reason", "start_date", "type",
  ]);
  assert.notEqual(repository.calls.create[0].employee_id, "victim");
});

test("applyLeave: the overlap refusal is 409 leave_overlaps and names the existing leave", async () => {
  const repository = fakeRepository({ overlapping: [{ id: "existing-leave" }] });
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("employee"), APPLY));

  assert.equal(error?.statusCode, 409);
  assert.equal(error.code, "leave_overlaps");
  assert.deepEqual(error.details, { existing_id: "existing-leave" });
});

test("applyLeave: the refusal is an HttpError, so the error handler shapes it and nothing is a 500", async () => {
  const error = await rejection(serviceFor(fakeRepository({ overlapping: [{ id: "existing-leave" }] }))
    .applyLeave(principalFor("employee"), APPLY));

  assert.ok(error instanceof HttpError);
});

test("applyLeave: a refused request never reaches the insert -- the repository's own write runs only after validate passes", async () => {
  // The fake mirrors the real create: validate throws, so nothing is inserted.
  const inserted = [];
  const repository = {
    async create(input, validate) {
      await validate({ overlapping: [{ id: "existing-leave" }] });
      inserted.push(input);
    },
  };
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("employee"), APPLY));

  assert.equal(error?.code, "leave_overlaps");
  assert.equal(inserted.length, 0);
});

test("applyLeave: every leave type is subject to the overlap rule -- Maternity is not exempt from double-booking", async () => {
  for (const type of LEAVE_TYPES) {
    const repository = fakeRepository({ overlapping: [{ id: "existing-leave" }] });
    const error = await rejection(serviceFor(repository).applyLeave(
      principalFor("employee"), { type, start_date: "2026-03-01", end_date: "2026-08-31", reason: "Long one" },
    ));

    assert.equal(error?.code, "leave_overlaps", type);
    assert.equal(repository.calls.create.length, 0, type);
  }
});

// ---- D40: no entitlements, no limits ---------------------------------------------------------

test("applyLeave: D40 -- there is no limit on length: a 400-day request of every type is accepted", async () => {
  for (const type of LEAVE_TYPES) {
    const repository = fakeRepository();
    const result = await serviceFor(repository).applyLeave(
      principalFor("employee"), { type, start_date: "2026-01-01", end_date: "2027-02-04", reason: "A very long one" },
    );

    assert.equal(result.status, "pending", type);
    assert.equal(repository.calls.create.length, 1, type);
  }
});

test("applyLeave: D40 -- there is no limit on number: any number of non-overlapping requests in one month is accepted", async () => {
  const repository = fakeRepository();
  const service = serviceFor(repository);

  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-03-${String(day).padStart(2, "0")}`;
    await service.applyLeave(principalFor("employee"), { type: "Annual", start_date: date, end_date: date, reason: "One day" });
  }

  assert.equal(repository.calls.create.length, 28, "all 28 one-day requests in the same month went in");
});

// ---------------------------------------------------------------------------
// decideLeave
// ---------------------------------------------------------------------------

test("decideLeave: admin, hr, manager and tl may decide a request in their scope; the employee role may not", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeRepository({ leaves: [leave()] });
    const error = await rejection(serviceFor(repository).decideLeave(principalFor(role), "leave-1", { status: "approved" }));

    if (["admin", "hr", "manager", "tl"].includes(role)) {
      assert.equal(error, null, role);
      assert.equal(repository.calls.decide.length, 1, role);
    } else {
      assert.equal(error?.statusCode, 403, role);
      assert.equal(error.code, "role_not_allowed", role);
      assert.equal(repository.calls.decide.length, 0, role);
    }
  }
});

test("decideLeave: the decider is the principal, recorded with the status", async () => {
  const repository = fakeRepository({ leaves: [leave()] });
  const principal = principalFor("manager");

  const result = await serviceFor(repository).decideLeave(principal, "leave-1", { status: "rejected" });

  assert.deepEqual(repository.calls.decide[0], { id: "leave-1", status: "rejected", decidedByEmployeeId: principal.employeeId });
  assert.equal(result.status, "rejected");
});

test("decideLeave: the role gate runs BEFORE the lookup, so a role that may never decide cannot probe ids", async () => {
  const repository = fakeRepository();
  const error = await rejection(serviceFor(repository).decideLeave(principalFor("employee"), "no-such-leave", { status: "approved" }));

  assert.equal(error?.statusCode, 403);
  assert.equal(repository.calls.findByIdForWrite.length, 0);
});

test("decideLeave: an unknown leave is 404", async () => {
  const error = await rejection(serviceFor(fakeRepository()).decideLeave(principalFor("admin"), "no-such-leave", { status: "approved" }));

  assert.equal(error?.statusCode, 404);
  assert.equal(error.code, "not_found");
});

test("decideLeave: a manager outside the department and a tl outside the team are refused before the write", async () => {
  const outside = leave({ employee_department_id: OTHER_DEPARTMENT, employee_team_lead_id: "tl-other" });

  for (const role of ["manager", "tl"]) {
    const repository = fakeRepository({ leaves: [outside] });
    const error = await rejection(serviceFor(repository).decideLeave(principalFor(role), "leave-1", { status: "approved" }));

    assert.equal(error?.statusCode, 403, role);
    assert.equal(error.code, "leave_scope_denied", role);
    assert.equal(repository.calls.decide.length, 0, role);
  }
});

test("decideLeave: D8 -- the service does NOT refuse a self-decision; the database does, and the 403 comes back intact", async () => {
  // An admin deciding their own request passes the service on purpose and reaches the repository,
  // whose guard is the leaves_no_self_approval constraint (translated to this 403 there).
  const own = leave({ employee_id: "principal-emp" });
  const databaseRefusal = new HttpError(403, "self_approval_denied", "You cannot decide your own leave request.");
  const repository = fakeRepository({ leaves: [own], decideError: databaseRefusal });

  const error = await rejection(serviceFor(repository).decideLeave(principalFor("admin"), "leave-1", { status: "approved" }));

  assert.equal(repository.calls.decide.length, 1, "the request reached the database layer");
  assert.equal(error?.statusCode, 403);
  assert.equal(error.code, "self_approval_denied");
});

test("decideLeave: a leave already decided surfaces the repository's 409 untouched", async () => {
  const decidedError = new HttpError(409, "leave_already_decided", "This leave request has already been decided.");
  const repository = fakeRepository({ leaves: [leave({ status: "approved" })], decideError: decidedError });

  const error = await rejection(serviceFor(repository).decideLeave(principalFor("admin"), "leave-1", { status: "rejected" }));

  assert.equal(error?.statusCode, 409);
  assert.equal(error.code, "leave_already_decided");
});

test("decideLeave: a leave deleted between the lookup and the write is 404, not a crash", async () => {
  const repository = fakeRepository({ leaves: [leave()], decideResult: null });
  const error = await rejection(serviceFor(repository).decideLeave(principalFor("admin"), "leave-1", { status: "approved" }));

  assert.equal(error?.statusCode, 404);
});

test("decideLeave: deciding does only the lookup and the guarded write -- nothing is created, re-checked or deleted", async () => {
  // There is no balance to re-check at approval (D40), so deciding needs nothing but the leave.
  const repository = fakeRepository({ leaves: [leave()] });
  await serviceFor(repository).decideLeave(principalFor("admin"), "leave-1", { status: "approved" });

  assert.equal(repository.calls.findByIdForWrite.length, 1);
  assert.equal(repository.calls.decide.length, 1);
  assert.equal(repository.calls.create.length, 0);
  assert.equal(repository.calls.deleteById.length, 0);
});

// ---------------------------------------------------------------------------
// deleteLeave
// ---------------------------------------------------------------------------

test("deleteLeave: admin and hr delete any leave in any status, with no pending guard", async () => {
  for (const role of ["admin", "hr"]) {
    for (const status of ["pending", "approved", "rejected"]) {
      const repository = fakeRepository({ leaves: [leave({ status })] });
      const principal = principalFor(role);

      await serviceFor(repository).deleteLeave(principal, "leave-1");

      assert.deepEqual(repository.calls.deleteById, [
        { id: "leave-1", deletedBy: principal.employeeId, mode: { pendingOnly: false } },
      ], `${role} ${status}`);
    }
  }
});

test("deleteLeave: an employee cancels their OWN pending leave -- guarded so a concurrent decision wins", async () => {
  for (const role of ["employee", "tl", "manager"]) {
    const principal = principalFor(role, { employeeId: EMPLOYEE });
    const repository = fakeRepository({ leaves: [leave({ employee_id: EMPLOYEE })] });

    await serviceFor(repository).deleteLeave(principal, "leave-1");

    assert.deepEqual(repository.calls.deleteById, [
      { id: "leave-1", deletedBy: EMPLOYEE, mode: { pendingOnly: true } },
    ], role);
  }
});

test("deleteLeave: an employee is refused on their own DECIDED leave (409) and nothing is deleted", async () => {
  for (const status of ["approved", "rejected"]) {
    const repository = fakeRepository({ leaves: [leave({ employee_id: EMPLOYEE, status })] });
    const error = await rejection(serviceFor(repository).deleteLeave(principalFor("employee", { employeeId: EMPLOYEE }), "leave-1"));

    assert.equal(error?.statusCode, 409, status);
    assert.equal(error.code, "leave_already_decided", status);
    assert.equal(repository.calls.deleteById.length, 0, status);
  }
});

test("deleteLeave: nobody can delete someone else's request unless they are admin or hr", async () => {
  for (const role of ["employee", "tl", "manager"]) {
    const repository = fakeRepository({ leaves: [leave()] });
    const error = await rejection(serviceFor(repository).deleteLeave(principalFor(role, { employeeId: "someone-else" }), "leave-1"));

    assert.equal(error?.statusCode, 403, role);
    assert.equal(error.code, "leave_scope_denied", role);
    assert.equal(repository.calls.deleteById.length, 0, role);
  }
});

test("deleteLeave: an unknown leave is 404, and for everyone alike", async () => {
  for (const role of USER_ROLES) {
    const error = await rejection(serviceFor(fakeRepository()).deleteLeave(principalFor(role), "no-such-leave"));

    assert.equal(error?.statusCode, 404, role);
    assert.equal(error.code, "not_found", role);
  }
});

test("deleteLeave: an account with no employee record is refused", async () => {
  const repository = fakeRepository({ leaves: [leave()] });
  const error = await rejection(serviceFor(repository).deleteLeave(principalFor("admin", { employeeId: null }), "leave-1"));

  assert.equal(error?.statusCode, 403);
  assert.equal(repository.calls.deleteById.length, 0);
});
