import assert from "node:assert/strict";
import test from "node:test";
import { createLeaveMutationService } from "../src/services/leaveMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. A fake repository stands in for leaveRepository and runs the service's `validate`
// callback the way the real one does, so the orchestration -- gate, then the callback's refusals,
// then the write -- is exercised. The authorization matrix is leaveAuthorization.test.js; the SQL is
// leaveRepository.test.js; the real locks and constraints are scripts/e2e-leaves.js.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const TL = "tl-1";
const EMPLOYEE = "emp-1";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id", employeeId: role === "tl" ? TL : "principal-emp", role, departmentId: DEPARTMENT, ...overrides,
});

const usageRow = (type, year, month, approved, pending = 0) => ({
  type, usage_year: year, usage_month: month, days_approved: approved, days_pending: pending,
});

/** A leave as findByIdForWrite returns it. */
const leave = (overrides = {}) => ({
  id: "leave-1", employee_id: EMPLOYEE, status: "pending",
  employee_department_id: DEPARTMENT, employee_team_lead_id: TL, ...overrides,
});

function fakeRepository({ joinedOn = "2020-01-01", overlapping = [], usage = [], leaves = [], decideResult, decideError } = {}) {
  const byId = new Map(leaves.map((row) => [row.id, row]));
  const calls = { create: [], findByIdForWrite: [], decide: [], deleteById: [] };
  return {
    calls,
    async create(input, validate) {
      calls.create.push(input);
      await validate({ joinedOn, overlapping, usage });
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

test("applyLeave: overlap is checked BEFORE the balance -- an overlapping over-balance request reports the overlap", async () => {
  const repository = fakeRepository({ overlapping: [{ id: "existing-leave" }], usage: [usageRow("Annual", 2026, 3, 2)] });
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("employee"), APPLY));

  assert.equal(error?.code, "leave_overlaps");
});

test("applyLeave: an over-balance request is 409 leave_balance_exceeded with the pool, period and numbers", async () => {
  const repository = fakeRepository({ usage: [usageRow("Annual", 2026, 3, 1, 1)] });
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("employee"), APPLY));

  assert.equal(error?.statusCode, 409);
  assert.equal(error.code, "leave_balance_exceeded");
  assert.deepEqual(error.details, {
    pool: "monthly", period: { year: 2026, month: 3 }, entitlement: 2, used: 2, requested: 2, remaining: 0,
  });
  assert.match(error.message, /monthly/);
});

test("applyLeave: the serious-need refusal is worded for the yearly pool", async () => {
  const repository = fakeRepository({ usage: [usageRow("Sick", 2026, 1, 14)] });
  const error = await rejection(serviceFor(repository).applyLeave(
    principalFor("employee"), { ...APPLY, type: "Emergency", start_date: "2026-06-01", end_date: "2026-06-01" },
  ));

  assert.equal(error?.code, "leave_balance_exceeded");
  assert.equal(error.details.pool, "serious_need");
  assert.match(error.message, /serious-need/);
});

test("applyLeave: a refused request never reaches the insert -- the repository's own write runs only after validate passes", async () => {
  // The fake mirrors the real create: validate throws, so nothing is inserted.
  const inserted = [];
  const repository = {
    async create(input, validate) {
      await validate({ joinedOn: "2020-01-01", overlapping: [], usage: [usageRow("Annual", 2026, 3, 2)] });
      inserted.push(input);
    },
  };
  const error = await rejection(serviceFor(repository).applyLeave(principalFor("employee"), APPLY));

  assert.equal(error?.code, "leave_balance_exceeded");
  assert.equal(inserted.length, 0);
});

test("applyLeave: Maternity is exempt from both pools, however long and however full they are", async () => {
  const fullPools = [usageRow("Annual", 2026, 3, 2), usageRow("Sick", 2026, 3, 14)];
  const repository = fakeRepository({ usage: fullPools });

  const result = await serviceFor(repository).applyLeave(
    principalFor("employee"), { type: "Maternity", start_date: "2026-03-01", end_date: "2026-08-31", reason: "Maternity" },
  );

  assert.equal(result.status, "pending");
  assert.equal(repository.calls.create.length, 1);
});

test("applyLeave: Maternity is still subject to the overlap rule -- exempt from the pools, not from double-booking", async () => {
  const repository = fakeRepository({ overlapping: [{ id: "existing-leave" }] });
  const error = await rejection(serviceFor(repository).applyLeave(
    principalFor("employee"), { type: "Maternity", start_date: "2026-03-01", end_date: "2026-08-31", reason: "Maternity" },
  ));

  assert.equal(error?.code, "leave_overlaps");
});

test("applyLeave: December's allowance is 12 -- 12 days pass, 13 are refused", async () => {
  const twelve = { type: "Casual", start_date: "2026-12-01", end_date: "2026-12-12", reason: "Break" };
  const thirteen = { ...twelve, end_date: "2026-12-13" };

  assert.equal((await serviceFor(fakeRepository()).applyLeave(principalFor("employee"), twelve)).status, "pending");

  const error = await rejection(serviceFor(fakeRepository()).applyLeave(principalFor("employee"), thirteen));
  assert.equal(error?.code, "leave_balance_exceeded");
  assert.equal(error.details.entitlement, 12);
});

test("applyLeave: a leave across a month boundary is judged per month -- 2 + 2 passes, and a full second month refuses it", async () => {
  const spanning = { type: "Annual", start_date: "2026-01-30", end_date: "2026-02-02", reason: "Trip" };

  assert.equal((await serviceFor(fakeRepository()).applyLeave(principalFor("employee"), spanning)).status, "pending");

  const error = await rejection(serviceFor(fakeRepository({ usage: [usageRow("Annual", 2026, 2, 1)] }))
    .applyLeave(principalFor("employee"), spanning));
  assert.equal(error?.code, "leave_balance_exceeded");
  assert.deepEqual(error.details.period, { year: 2026, month: 2 });
});

test("applyLeave: the refusals are HttpErrors, so the error handler shapes them and nothing is a 500", async () => {
  const error = await rejection(serviceFor(fakeRepository({ usage: [usageRow("Annual", 2026, 3, 2)] }))
    .applyLeave(principalFor("employee"), APPLY));

  assert.ok(error instanceof HttpError);
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

test("decideLeave: no balance is read -- approving a pending request changes no usage, so there is nothing to re-check", async () => {
  // The fake has no usage reader at all; deciding must therefore not need one.
  const repository = fakeRepository({ leaves: [leave()] });
  await serviceFor(repository).decideLeave(principalFor("admin"), "leave-1", { status: "approved" });

  assert.equal(repository.calls.create.length, 0);
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
