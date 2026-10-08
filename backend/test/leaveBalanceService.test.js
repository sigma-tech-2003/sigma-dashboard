import assert from "node:assert/strict";
import test from "node:test";
import { createLeaveBalanceService } from "../src/services/leaveBalanceService.js";
import { LEAVE_TYPES } from "../src/utils/leaveTypes.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. The scope rules are employeeScopeService's (employeeScope.test.js); this proves the
// balance service applies them (D31, unchanged by D40): the employee reads their own, admin and hr any,
// a manager their department, a tl their team -- and everything else is a 404 indistinguishable from
// "no such employee". What it reports is days TAKEN, not days remaining (D40): there are no entitlements.

const D1 = "dept-1";
const D2 = "dept-2";
const TL_A = "tl-a";
const TL_B = "tl-b";

const employee = (id, role, departmentId, teamLeadId = null) => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: "active",
});
const EMPLOYEES = [
  employee(TL_A, "tl", D1), employee(TL_B, "tl", D1),
  employee("e-a", "employee", D1, TL_A),   // on TL_A's team, department 1
  employee("e-b", "employee", D1, TL_B),   // on TL_B's team, department 1
  employee("e-other", "employee", D2),     // department 2
  employee("manager-1", "manager", D1),
];

/** A row of employee_leave_usage as leaveRepository.daysTaken returns it. */
const takenRow = (type, daysUsed) => ({ type, days_used: daysUsed });

function fixtures({ rows = [], missing = false } = {}) {
  const calls = { findById: [], daysTaken: [] };
  return {
    calls,
    employeeRepository: {
      async findById(id) {
        calls.findById.push(id);
        return EMPLOYEES.find((row) => row.id === id) ?? null;
      },
    },
    leaveRepository: {
      async daysTaken(employeeId, year) {
        calls.daysTaken.push({ employeeId, year });
        return missing ? null : rows;
      },
    },
  };
}

const serviceFor = (parts, now = () => new Date("2026-03-15T08:00:00Z")) =>
  createLeaveBalanceService({ ...parts, timeZone: "Asia/Karachi", now });

const principalFor = (role, overrides = {}) => ({
  userId: "user-id", employeeId: `${role}-self`, role, departmentId: D1, ...overrides,
});

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

// ---------------------------------------------------------------------------
// Whose days taken each role may read
// ---------------------------------------------------------------------------

test("an employee reads their own balance, and it is the default when no employee_id is given", async () => {
  const parts = fixtures();
  const principal = principalFor("employee", { employeeId: "e-a" });

  const balance = await serviceFor(parts).getBalance(principal);

  assert.equal(balance.employee_id, "e-a");
  assert.deepEqual(parts.calls.daysTaken, [{ employeeId: "e-a", year: 2026 }]);
});

test("an employee cannot read anyone else's balance -- a colleague on the same team, or in another department", async () => {
  for (const target of ["e-b", "e-other", TL_A, "manager-1"]) {
    const parts = fixtures();
    const error = await rejection(serviceFor(parts).getBalance(principalFor("employee", { employeeId: "e-a" }), { employeeId: target }));

    assert.equal(error?.statusCode, 404, target);
    assert.equal(error.code, "not_found", target);
    assert.equal(parts.calls.daysTaken.length, 0, `${target}: nothing is read for a refused target`);
  }
});

test("admin and hr read any employee's balance, in any department", async () => {
  for (const role of ["admin", "hr"]) {
    for (const target of ["e-a", "e-b", "e-other", TL_A, "manager-1"]) {
      const balance = await serviceFor(fixtures()).getBalance(principalFor(role, { departmentId: null }), { employeeId: target });
      assert.equal(balance.employee_id, target, `${role} -> ${target}`);
    }
  }
});

test("a manager reads their own department's employees and no one else's", async () => {
  const manager = principalFor("manager", { employeeId: "manager-1", departmentId: D1 });

  for (const target of ["e-a", "e-b", TL_A, "manager-1"]) {
    const balance = await serviceFor(fixtures()).getBalance(manager, { employeeId: target });
    assert.equal(balance.employee_id, target, target);
  }
  const error = await rejection(serviceFor(fixtures()).getBalance(manager, { employeeId: "e-other" }));
  assert.equal(error?.statusCode, 404);
});

test("a manager with no department reads nobody's -- not even by default", async () => {
  const manager = principalFor("manager", { employeeId: "manager-1", departmentId: null });

  const error = await rejection(serviceFor(fixtures()).getBalance(manager, { employeeId: "e-a" }));
  assert.equal(error?.statusCode, 404);
});

test("a tl reads their own team and themselves, and not another team in the same department", async () => {
  const tl = principalFor("tl", { employeeId: TL_A, departmentId: D1 });

  for (const target of ["e-a", TL_A]) {
    const balance = await serviceFor(fixtures()).getBalance(tl, { employeeId: target });
    assert.equal(balance.employee_id, target, target);
  }
  for (const target of ["e-b", TL_B, "e-other"]) {
    const error = await rejection(serviceFor(fixtures()).getBalance(tl, { employeeId: target }));
    assert.equal(error?.statusCode, 404, target);
  }
});

test("an unknown employee and an out-of-scope one produce the SAME 404, so existence is never confirmed", async () => {
  const principal = principalFor("employee", { employeeId: "e-a" });

  const unknown = await rejection(serviceFor(fixtures()).getBalance(principal, { employeeId: "no-such-employee" }));
  const outOfScope = await rejection(serviceFor(fixtures()).getBalance(principal, { employeeId: "e-other" }));

  assert.equal(unknown?.statusCode, 404);
  assert.equal(outOfScope?.statusCode, 404);
  assert.equal(unknown.code, outOfScope.code);
  assert.equal(unknown.message, outOfScope.message);
});

test("an employee whose row vanished between the scope check and the usage read is 404, not a crash", async () => {
  const error = await rejection(serviceFor(fixtures({ missing: true })).getBalance(principalFor("admin"), { employeeId: "e-a" }));

  assert.equal(error?.statusCode, 404);
});

test("an account with no employee record, or an unknown role, is refused outright (403)", async () => {
  for (const principal of [
    principalFor("admin", { employeeId: null }), principalFor("superuser"), null, undefined,
  ]) {
    const error = await rejection(serviceFor(fixtures()).getBalance(principal));
    assert.equal(error?.statusCode, 403);
    assert.equal(error.code, "role_not_allowed");
  }
});

test("every role can read its own balance", async () => {
  for (const role of USER_ROLES) {
    const principal = principalFor(role, { employeeId: role === "tl" ? TL_A : role === "manager" ? "manager-1" : "e-a" });
    const balance = await serviceFor(fixtures()).getBalance(principal);
    assert.equal(balance.employee_id, principal.employeeId, role);
  }
});

// ---------------------------------------------------------------------------
// What is reported: days TAKEN, per type, for a calendar year (D40)
// ---------------------------------------------------------------------------

test("the year defaults to today's in the COMPANY timezone, and that year is what is read", async () => {
  // 21:00 UTC on 31 Dec 2026 is already 1 Jan 2027 in Karachi.
  const parts = fixtures();
  const balance = await serviceFor(parts, () => new Date("2026-12-31T21:00:00Z"))
    .getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.equal(balance.as_of, "2027-01-01");
  assert.equal(balance.year, 2027);
  assert.deepEqual(parts.calls.daysTaken, [{ employeeId: "e-a", year: 2027 }]);
});

test("an explicit as_of picks the year to report -- only its year matters", async () => {
  const parts = fixtures();
  const balance = await serviceFor(parts).getBalance(principalFor("admin"), { employeeId: "e-a", asOf: "2025-12-10" });

  assert.equal(balance.as_of, "2025-12-10");
  assert.equal(balance.year, 2025);
  assert.deepEqual(parts.calls.daysTaken, [{ employeeId: "e-a", year: 2025 }]);
});

test("days taken are reported per type, with a total", async () => {
  const parts = fixtures({ rows: [takenRow("Annual", 5), takenRow("Sick", 3), takenRow("Maternity", 112)] });
  const balance = await serviceFor(parts).getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.deepEqual(balance.taken, { Annual: 5, Sick: 3, Casual: 0, Maternity: 112, Emergency: 0 });
  assert.equal(balance.total, 120);
});

test("every leave type is always present, with 0 where nothing was taken", async () => {
  const balance = await serviceFor(fixtures()).getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.deepEqual(Object.keys(balance.taken), [...LEAVE_TYPES]);
  assert.ok(Object.values(balance.taken).every((days) => days === 0));
  assert.equal(balance.total, 0);
});

test("D40 -- it reports days TAKEN only: there is no entitlement, allowance, pool or remaining figure", async () => {
  const balance = await serviceFor(fixtures({ rows: [takenRow("Annual", 40)] }))
    .getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.deepEqual(Object.keys(balance).sort(), ["as_of", "employee_id", "taken", "total", "year"]);
  assert.equal(balance.taken.Annual, 40, "40 days in a year is simply reported; nothing marks it as too many");
});

test("a count that arrives as a numeric string is still reported as a number", async () => {
  const balance = await serviceFor(fixtures({ rows: [takenRow("Annual", "7")] }))
    .getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.strictEqual(balance.taken.Annual, 7);
  assert.strictEqual(balance.total, 7);
});

test("a type the service does not know is ignored rather than invented as a new key", async () => {
  const balance = await serviceFor(fixtures({ rows: [takenRow("Annual", 2), takenRow("Sabbatical", 9)] }))
    .getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.deepEqual(Object.keys(balance.taken), [...LEAVE_TYPES]);
  assert.equal(balance.total, 2);
});
