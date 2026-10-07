import assert from "node:assert/strict";
import test from "node:test";
import { createLeaveBalanceService } from "../src/services/leaveBalanceService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. The scope rules are employeeScopeService's (employeeScope.test.js); this proves the
// balance service applies them (D31): the employee reads their own, admin and hr any, a manager their
// department, a tl their team -- and everything else is a 404 indistinguishable from "no such employee".

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

const usageRow = (type, year, month, approved, pending = 0) => ({
  type, usage_year: year, usage_month: month, days_approved: approved, days_pending: pending,
});

function fixtures({ joinedOn = "2020-01-01", usage = [], missingInputs = false } = {}) {
  const calls = { findById: [], balanceInputs: [] };
  return {
    calls,
    employeeRepository: {
      async findById(id) {
        calls.findById.push(id);
        return EMPLOYEES.find((row) => row.id === id) ?? null;
      },
    },
    leaveRepository: {
      async balanceInputs(employeeId, years) {
        calls.balanceInputs.push({ employeeId, years });
        return missingInputs ? null : { joinedOn, usage };
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
// Whose balance each role may read
// ---------------------------------------------------------------------------

test("an employee reads their own balance, and it is the default when no employee_id is given", async () => {
  const parts = fixtures();
  const principal = principalFor("employee", { employeeId: "e-a" });

  const balance = await serviceFor(parts).getBalance(principal);

  assert.equal(balance.employee_id, "e-a");
  assert.equal(parts.calls.balanceInputs[0].employeeId, "e-a");
});

test("an employee cannot read anyone else's balance -- a colleague on the same team, or in another department", async () => {
  for (const target of ["e-b", "e-other", TL_A, "manager-1"]) {
    const parts = fixtures();
    const error = await rejection(serviceFor(parts).getBalance(principalFor("employee", { employeeId: "e-a" }), { employeeId: target }));

    assert.equal(error?.statusCode, 404, target);
    assert.equal(error.code, "not_found", target);
    assert.equal(parts.calls.balanceInputs.length, 0, `${target}: no usage is read for a refused target`);
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
  const error = await rejection(serviceFor(fixtures({ missingInputs: true })).getBalance(principalFor("admin"), { employeeId: "e-a" }));

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
// What is computed
// ---------------------------------------------------------------------------

test("as_of defaults to today in the COMPANY timezone, and the usage is read for that calendar year only", async () => {
  // 21:00 UTC on 31 Dec 2026 is already 1 Jan 2027 in Karachi.
  const parts = fixtures();
  const balance = await serviceFor(parts, () => new Date("2026-12-31T21:00:00Z")).getBalance(principalFor("employee", { employeeId: "e-a" }));

  assert.equal(balance.as_of, "2027-01-01");
  assert.deepEqual(parts.calls.balanceInputs[0].years, [2027]);
  assert.deepEqual(balance.pools.monthly.period, { year: 2027, month: 1 });
});

test("an explicit as_of picks the month and year to report", async () => {
  const parts = fixtures();
  const balance = await serviceFor(parts).getBalance(principalFor("admin"), { employeeId: "e-a", asOf: "2026-12-10" });

  assert.equal(balance.as_of, "2026-12-10");
  assert.deepEqual(parts.calls.balanceInputs[0].years, [2026]);
  assert.equal(balance.pools.monthly.entitlement, 12, "December's allowance is 12");
});

test("the balance is the entitlement rules applied to the view's rows", async () => {
  const parts = fixtures({
    usage: [
      usageRow("Annual", 2026, 3, 1, 1),
      usageRow("Annual", 2026, 4, 2),
      usageRow("Sick", 2026, 1, 4),
      usageRow("Emergency", 2026, 9, 1, 2),
      usageRow("Maternity", 2026, 3, 31),
    ],
  });
  const balance = await serviceFor(parts).getBalance(principalFor("employee", { employeeId: "e-a" }), { asOf: "2026-03-20" });

  assert.deepEqual(balance.pools.monthly, {
    period: { year: 2026, month: 3 }, entitlement: 2, approved: 1, pending: 1, remaining: 0,
  });
  assert.deepEqual(balance.pools.serious_need, {
    period: { year: 2026 }, entitlement: 14, approved: 5, pending: 2, remaining: 7,
  });
  assert.equal(balance.types.Maternity, null);
});

test("joined_on comes from the repository's text, so a mid-month joiner still gets the month's full 2 and earlier months none", async () => {
  const parts = fixtures({ joinedOn: "2026-03-28" });

  const during = await serviceFor(parts).getBalance(principalFor("admin"), { employeeId: "e-a", asOf: "2026-03-30" });
  const before = await serviceFor(parts).getBalance(principalFor("admin"), { employeeId: "e-a", asOf: "2026-02-10" });

  assert.equal(during.pools.monthly.entitlement, 2);
  assert.equal(before.pools.monthly.entitlement, 0);
});

test("the target's balance is read through the repository, never through employeeRepository's joined_on (a local-midnight Date)", async () => {
  const parts = fixtures();
  await serviceFor(parts).getBalance(principalFor("admin"), { employeeId: "e-a" });

  assert.equal(parts.calls.balanceInputs.length, 1);
});
