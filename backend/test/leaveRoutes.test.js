import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createLeaveBalanceService } from "../src/services/leaveBalanceService.js";
import { createLeaveMutationService } from "../src/services/leaveMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The authorization matrix lives in leaveAuthorization.test.js, the orchestration in
// leaveMutationService.test.js and the rules in leaveEntitlements.test.js; these tests prove the real
// services are wired to real HTTP status codes and bodies, that the strict schemas guard the door, and
// that /leave-balances scopes as D31 settled -- against fake repositories (no database).
//
// Two refusals are DATABASE constraints or guards: the self-decision (leaves_no_self_approval) and
// the guarded UPDATEs that make a decided leave immutable. A fake repository cannot prove the
// database refuses; it mirrors the refusal so the HTTP mapping is exercised (the 403 and the 409
// reach the client intact and the service does not get in their way). The real refusals are proved
// against Postgres by scripts/e2e-leaves.js, and the SQL-error -> HttpError translation by
// leaveRepository.test.js.

const D1 = randomUUID();
const D2 = randomUUID();
const TL_A = randomUUID();
const TL_B = randomUUID();
const E1 = randomUUID();        // employee on TL_A's team, department 1
const E2 = randomUUID();        // employee on TL_B's team, department 1
const E_OTHER = randomUUID();   // employee in department 2
const MANAGER = randomUUID();   // manager of department 1

const employee = (id, role, departmentId, teamLeadId = null) => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: "active",
});
const EMPLOYEES = [
  employee(TL_A, "tl", D1), employee(TL_B, "tl", D1),
  employee(E1, "employee", D1, TL_A), employee(E2, "employee", D1, TL_B),
  employee(E_OTHER, "employee", D2), employee(MANAGER, "manager", D1),
];

function principalFor(role, overrides = {}) {
  const employeeId = { tl: TL_A, manager: MANAGER, employee: E1 }[role] ?? randomUUID();
  return { userId: randomUUID(), employeeId, role, departmentId: role === "admin" || role === "hr" ? null : D1, ...overrides };
}

/** A leave as findByIdForWrite returns it; belongs to E1 (TL_A's team, department 1) unless overridden. */
function leaveRow(overrides = {}) {
  return {
    id: randomUUID(), employee_id: E1, status: "pending",
    employee_department_id: D1, employee_team_lead_id: TL_A, ...overrides,
  };
}

const usageRow = (type, year, month, approved, pending = 0) => ({
  type, usage_year: year, usage_month: month, days_approved: approved, days_pending: pending,
});

/**
 * Mirrors the real repository's contract. `decide` mirrors the two database guarantees -- a decider
 * equal to the leave's employee is refused 403 (leaves_no_self_approval) and a leave that is not
 * pending is refused 409 (the guarded UPDATE) -- so the HTTP mapping of the real refusals is
 * exercised; it is a mirror, not the proof (see the header).
 */
function fakeLeaveRepository(seed = [], { joinedOn = "2020-01-01", usage = [], overlapping = [] } = {}) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const calls = { create: [], decide: [], deleteById: [], balanceInputs: [] };
  return {
    calls,
    async findByIdForWrite(id) { return byId.get(id) ?? null; },
    async create(input, validate) {
      await validate({ joinedOn, overlapping, usage });
      calls.create.push(input);
      return { id: randomUUID(), ...input, status: "pending", days: 1 };
    },
    async decide(id, { status, decidedByEmployeeId }) {
      calls.decide.push({ id, status, decidedByEmployeeId });
      const row = byId.get(id);
      if (decidedByEmployeeId === row.employee_id) {
        throw new HttpError(403, "self_approval_denied", "You cannot decide your own leave request.");
      }
      if (row.status !== "pending") {
        throw new HttpError(409, "leave_already_decided", "This leave request has already been decided.");
      }
      return { id, status, decided_by_employee_id: decidedByEmployeeId };
    },
    async deleteById(id, deletedBy, mode) {
      calls.deleteById.push({ id, deletedBy, mode });
      const row = byId.get(id);
      if (mode.pendingOnly && row.status !== "pending") {
        throw new HttpError(409, "leave_already_decided", "A decided leave request cannot be cancelled.");
      }
    },
    async balanceInputs(employeeId, years) {
      calls.balanceInputs.push({ employeeId, years });
      return { joinedOn, usage };
    },
  };
}

const NOW = () => new Date("2026-03-04T10:00:00Z");

async function startApp(principal, leaveRepository) {
  const leaveMutationService = createLeaveMutationService({ leaveRepository, timeZone: "UTC", now: NOW });
  const leaveBalanceService = createLeaveBalanceService({
    leaveRepository,
    employeeRepository: { async findById(id) { return EMPLOYEES.find((row) => row.id === id) ?? null; } },
    timeZone: "UTC",
    now: NOW,
  });
  const app = createApp({ verifyAccessToken: async () => principal, repositories: {}, leaveMutationService, leaveBalanceService });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async request(method, pathname, body) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Runs `fn(app, repository)` against a fresh server, always closing it. */
async function withApp(principal, repository, fn) {
  const app = await startApp(principal, repository);
  try {
    return await fn(app, repository);
  } finally {
    await app.close();
  }
}

const VALID_APPLY = Object.freeze({ type: "Annual", start_date: "2026-03-10", end_date: "2026-03-11", reason: "Family" });
const DECIDER_ROLES = new Set(["admin", "hr", "manager", "tl"]);

// ---------------------------------------------------------------------------
// Every role against apply, decide and delete
// ---------------------------------------------------------------------------

test("POST /leaves: every role may apply (201), for themselves", async () => {
  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    await withApp(principal, fakeLeaveRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/leaves", VALID_APPLY);

      assert.equal(response.status, 201, role);
      assert.equal(repository.calls.create.length, 1, role);
      assert.equal(repository.calls.create[0].employee_id, principal.employeeId, role);
      assert.equal(response.body.data.status, "pending", role);
    });
  }
});

test("POST /leaves: applied_on is today (company date), supplied by the server", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app, repository) => {
    await app.request("POST", "/api/v1/leaves", VALID_APPLY);
    assert.equal(repository.calls.create[0].applied_on, "2026-03-04");
  });
});

test("PATCH /leaves/:id: admin, hr, manager and tl decide a request in their scope (200); employee is denied (403)", async () => {
  const target = leaveRow();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeLeaveRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/leaves/${target.id}`, { status: "approved" });

      if (DECIDER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(response.body.data.status, "approved", role);
        assert.equal(repository.calls.decide.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.decide.length, 0, role);
      }
    });
  }
});

test("PATCH /leaves/:id: reject works the same as approve, and records the decider", async () => {
  const target = leaveRow();
  const principal = principalFor("manager");
  await withApp(principal, fakeLeaveRepository([target]), async (app, repository) => {
    const response = await app.request("PATCH", `/api/v1/leaves/${target.id}`, { status: "rejected" });

    assert.equal(response.status, 200);
    assert.deepEqual(repository.calls.decide[0], { id: target.id, status: "rejected", decidedByEmployeeId: principal.employeeId });
  });
});

test("PATCH /leaves/:id: a manager outside the department and a tl outside the team are refused (403 leave_scope_denied)", async () => {
  const outsider = leaveRow({ employee_id: E_OTHER, employee_department_id: D2, employee_team_lead_id: null });
  for (const role of ["manager", "tl"]) {
    await withApp(principalFor(role), fakeLeaveRepository([outsider]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/leaves/${outsider.id}`, { status: "approved" });

      assert.equal(response.status, 403, role);
      assert.equal(response.body.error.code, "leave_scope_denied", role);
      assert.equal(repository.calls.decide.length, 0, role);
    });
  }
});

test("PATCH /leaves/:id: admin and hr decide across departments", async () => {
  const outsider = leaveRow({ employee_id: E_OTHER, employee_department_id: D2, employee_team_lead_id: null });
  for (const role of ["admin", "hr"]) {
    await withApp(principalFor(role), fakeLeaveRepository([outsider]), async (app) => {
      assert.equal((await app.request("PATCH", `/api/v1/leaves/${outsider.id}`, { status: "approved" })).status, 200, role);
    });
  }
});

test("DELETE /leaves/:id: admin and hr delete any leave in any status (204)", async () => {
  for (const role of ["admin", "hr"]) {
    for (const status of ["pending", "approved", "rejected"]) {
      const target = leaveRow({ status });
      await withApp(principalFor(role), fakeLeaveRepository([target]), async (app, repository) => {
        const response = await app.request("DELETE", `/api/v1/leaves/${target.id}`);

        assert.equal(response.status, 204, `${role} ${status}`);
        assert.deepEqual(repository.calls.deleteById[0].mode, { pendingOnly: false }, `${role} ${status}`);
      });
    }
  }
});

test("DELETE /leaves/:id: a manager or tl cannot delete a leave in their scope that is not their own (403), and neither can an employee", async () => {
  for (const role of ["employee", "tl", "manager"]) {
    const target = leaveRow({ employee_id: randomUUID() });
    const principal = principalFor(role, { employeeId: role === "tl" ? TL_A : role === "manager" ? MANAGER : E2 });
    await withApp(principal, fakeLeaveRepository([target]), async (app, repository) => {
      const response = await app.request("DELETE", `/api/v1/leaves/${target.id}`);

      assert.equal(response.status, 403, role);
      assert.equal(response.body.error.code, "leave_scope_denied", role);
      assert.equal(repository.calls.deleteById.length, 0, role);
    });
  }
});

// ---------------------------------------------------------------------------
// Self-decision, refused at the database and surfacing as 403
// ---------------------------------------------------------------------------

test("PATCH /leaves/:id: deciding your OWN request is 403 self_approval_denied -- for admin, hr and manager, whom the service lets through", async () => {
  for (const role of ["admin", "hr", "manager"]) {
    const principal = principalFor(role);
    const own = leaveRow({ employee_id: principal.employeeId, employee_department_id: D1 });
    await withApp(principal, fakeLeaveRepository([own]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/leaves/${own.id}`, { status: "approved" });

      assert.equal(repository.calls.decide.length, 1, `${role}: the request reached the database layer, which is what refused it`);
      assert.equal(response.status, 403, role);
      assert.equal(response.body.error.code, "self_approval_denied", role);
    });
  }
});

test("PATCH /leaves/:id: a tl deciding their own request is refused 403 by SCOPE before the database is reached", async () => {
  const principal = principalFor("tl");
  const own = leaveRow({ employee_id: TL_A, employee_department_id: D1, employee_team_lead_id: null });
  await withApp(principal, fakeLeaveRepository([own]), async (app, repository) => {
    const response = await app.request("PATCH", `/api/v1/leaves/${own.id}`, { status: "approved" });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "leave_scope_denied");
    assert.equal(repository.calls.decide.length, 0);
  });
});

test("PATCH /leaves/:id: an already-decided leave is 409 leave_already_decided, for every approver role", async () => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    for (const status of ["approved", "rejected"]) {
      const target = leaveRow({ status });
      await withApp(principalFor(role), fakeLeaveRepository([target]), async (app) => {
        const response = await app.request("PATCH", `/api/v1/leaves/${target.id}`, { status: status === "approved" ? "rejected" : "approved" });

        assert.equal(response.status, 409, `${role} ${status}`);
        assert.equal(response.body.error.code, "leave_already_decided", `${role} ${status}`);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// An employee cancelling their own leave
// ---------------------------------------------------------------------------

test("DELETE /leaves/:id: an employee cancels their own PENDING leave (204), with the pending guard on", async () => {
  const target = leaveRow({ employee_id: E1 });
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository([target]), async (app, repository) => {
    const response = await app.request("DELETE", `/api/v1/leaves/${target.id}`);

    assert.equal(response.status, 204);
    assert.deepEqual(repository.calls.deleteById, [{ id: target.id, deletedBy: E1, mode: { pendingOnly: true } }]);
  });
});

test("DELETE /leaves/:id: an employee is refused on their own DECIDED leave (409), approved or rejected", async () => {
  for (const status of ["approved", "rejected"]) {
    const target = leaveRow({ employee_id: E1, status });
    await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository([target]), async (app, repository) => {
      const response = await app.request("DELETE", `/api/v1/leaves/${target.id}`);

      assert.equal(response.status, 409, status);
      assert.equal(response.body.error.code, "leave_already_decided", status);
      assert.equal(repository.calls.deleteById.length, 0, status);
    });
  }
});

test("DELETE /leaves/:id: a tl and a manager can cancel their OWN pending leave, as employees", async () => {
  for (const [role, id] of [["tl", TL_A], ["manager", MANAGER]]) {
    const target = leaveRow({ employee_id: id });
    await withApp(principalFor(role, { employeeId: id }), fakeLeaveRepository([target]), async (app, repository) => {
      assert.equal((await app.request("DELETE", `/api/v1/leaves/${target.id}`)).status, 204, role);
      assert.deepEqual(repository.calls.deleteById[0].mode, { pendingOnly: true }, role);
    });
  }
});

// ---------------------------------------------------------------------------
// Over-balance and overlap refusals, through HTTP
// ---------------------------------------------------------------------------

test("POST /leaves: over the monthly allowance is 409 leave_balance_exceeded with the numbers in details", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository([], { usage: [usageRow("Annual", 2026, 3, 1, 1)] }), async (app, repository) => {
    const response = await app.request("POST", "/api/v1/leaves", VALID_APPLY);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "leave_balance_exceeded");
    assert.deepEqual(response.body.error.details, {
      pool: "monthly", period: { year: 2026, month: 3 }, entitlement: 2, used: 2, requested: 2, remaining: 0,
    });
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST /leaves: over the 14-day serious-need allowance is 409, naming the yearly pool", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository([], { usage: [usageRow("Sick", 2026, 1, 14)] }), async (app) => {
    const response = await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, type: "Emergency" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.details.pool, "serious_need");
    assert.deepEqual(response.body.error.details.period, { year: 2026 });
  });
});

test("POST /leaves: an overlapping leave is 409 leave_overlaps, carrying the existing id", async () => {
  const existing = randomUUID();
  await withApp(principalFor("employee"), fakeLeaveRepository([], { overlapping: [{ id: existing }] }), async (app, repository) => {
    const response = await app.request("POST", "/api/v1/leaves", VALID_APPLY);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "leave_overlaps");
    assert.deepEqual(response.body.error.details, { existing_id: existing });
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST /leaves: Maternity is exempt from both pools -- a long request on full pools is 201", async () => {
  const fullPools = [usageRow("Annual", 2026, 3, 2), usageRow("Sick", 2026, 3, 14)];
  await withApp(principalFor("employee"), fakeLeaveRepository([], { usage: fullPools }), async (app) => {
    const response = await app.request("POST", "/api/v1/leaves", {
      type: "Maternity", start_date: "2026-03-01", end_date: "2026-08-31", reason: "Maternity",
    });

    assert.equal(response.status, 201);
  });
});

test("POST /leaves: December's allowance is 12 -- 12 days are 201, 13 are 409", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app) => {
    const twelve = await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, start_date: "2026-12-01", end_date: "2026-12-12" });
    const thirteen = await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, start_date: "2026-12-01", end_date: "2026-12-13" });

    assert.equal(twelve.status, 201);
    assert.equal(thirteen.status, 409);
    assert.equal(thirteen.body.error.details.entitlement, 12);
  });
});

test("POST /leaves: a leave across a month boundary is judged per month (30 Jan - 2 Feb is 2 + 2, so it passes)", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, start_date: "2026-01-30", end_date: "2026-02-02" });
    assert.equal(response.status, 201);
  });
});

// ---------------------------------------------------------------------------
// Strict schemas
// ---------------------------------------------------------------------------

test("POST /leaves: strict schema -- every server-owned or foreign field is refused (400), and nothing is created", async () => {
  const extras = [
    { employee_id: randomUUID() }, { days: 1 }, { status: "approved" }, { applied_on: "2026-01-01" },
    { decided_by_employee_id: randomUUID() }, { decided_at: "2026-01-01T00:00:00Z" }, { decision_recorded: true },
    { deleted_at: "2026-01-01T00:00:00Z" }, { deleted_by_employee_id: randomUUID() }, { id: randomUUID() },
  ];
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app, repository) => {
    for (const extra of extras) {
      const response = await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, ...extra });
      assert.equal(response.status, 400, Object.keys(extra)[0]);
      assert.equal(response.body.error.code, "invalid_request", Object.keys(extra)[0]);
    }
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST /leaves: rejects a bad type, bad or impossible dates, end before start, an empty reason and a missing field", async () => {
  const bodies = [
    { ...VALID_APPLY, type: "Sabbatical" },
    { ...VALID_APPLY, type: "annual" },
    { ...VALID_APPLY, start_date: "10/03/2026" },
    { ...VALID_APPLY, start_date: "2026-02-30" },
    { ...VALID_APPLY, start_date: "2026-03-12", end_date: "2026-03-10" },
    { ...VALID_APPLY, reason: "" },
    { ...VALID_APPLY, reason: "   " },
    { ...VALID_APPLY, reason: "x".repeat(2001) },
    { type: "Annual", start_date: "2026-03-10", end_date: "2026-03-11" },
    { ...VALID_APPLY, start_date: "2026-01-01", end_date: "2027-06-01" },
  ];
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app, repository) => {
    for (const body of bodies) {
      const response = await app.request("POST", "/api/v1/leaves", body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST /leaves: backdating is allowed, and a year-long Maternity range fits the sanity bound", async () => {
  await withApp(principalFor("employee"), fakeLeaveRepository(), async (app) => {
    assert.equal((await app.request("POST", "/api/v1/leaves", { ...VALID_APPLY, start_date: "2020-01-06", end_date: "2020-01-06" })).status, 201);
    assert.equal((await app.request("POST", "/api/v1/leaves", {
      type: "Maternity", start_date: "2026-01-01", end_date: "2026-12-31", reason: "Maternity",
    })).status, 201);
  });
});

test("PATCH /leaves/:id: strict schema -- status is the ONLY field, and only approved or rejected", async () => {
  const target = leaveRow();
  const bodies = [
    { status: "pending" }, { status: "cancelled" }, { status: "Approved" }, {},
    { status: "approved", reason: "edit" }, { status: "approved", start_date: "2026-04-01" },
    { status: "approved", decided_by_employee_id: randomUUID() }, { reason: "edit only" },
  ];
  await withApp(principalFor("admin"), fakeLeaveRepository([target]), async (app, repository) => {
    for (const body of bodies) {
      const response = await app.request("PATCH", `/api/v1/leaves/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(repository.calls.decide.length, 0);
  });
});

test("a malformed :id is a 404, not a 400, for PATCH and DELETE -- matching the read side", async () => {
  await withApp(principalFor("admin"), fakeLeaveRepository(), async (app) => {
    assert.equal((await app.request("PATCH", "/api/v1/leaves/not-a-uuid", { status: "approved" })).status, 404);
    assert.equal((await app.request("DELETE", "/api/v1/leaves/not-a-uuid")).status, 404);
  });
});

test("an unknown leave is 404 for PATCH and DELETE, for every approver role", async () => {
  const ghost = randomUUID();
  for (const role of ["admin", "hr", "manager", "tl"]) {
    await withApp(principalFor(role), fakeLeaveRepository(), async (app) => {
      assert.equal((await app.request("PATCH", `/api/v1/leaves/${ghost}`, { status: "approved" })).status, 404, role);
      assert.equal((await app.request("DELETE", `/api/v1/leaves/${ghost}`)).status, 404, role);
    });
  }
});

test("there is no PUT and no edit: a leave cannot be changed after it is applied", async () => {
  const target = leaveRow();
  await withApp(principalFor("admin"), fakeLeaveRepository([target]), async (app) => {
    const response = await app.request("PUT", `/api/v1/leaves/${target.id}`, VALID_APPLY);
    assert.equal(response.status, 404);
  });
});

test("the write routes require authentication, like every other route", async () => {
  const repository = fakeLeaveRepository();
  const leaveMutationService = createLeaveMutationService({ leaveRepository: repository, timeZone: "UTC", now: NOW });
  const server = createServer(createApp({
    verifyAccessToken: async () => { throw new HttpError(401, "unauthorized", "no"); }, repositories: {}, leaveMutationService,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    for (const [method, path] of [["POST", "/api/v1/leaves"], ["GET", "/api/v1/leave-balances"]]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    assert.equal(repository.calls.create.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// GET /leave-balances: scoping for the employee and for each approver role
// ---------------------------------------------------------------------------

test("GET /leave-balances: an employee gets their own balance by default (200)", async () => {
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository(), async (app, repository) => {
    const response = await app.request("GET", "/api/v1/leave-balances");

    assert.equal(response.status, 200);
    assert.equal(response.body.data.employee_id, E1);
    assert.equal(response.body.data.as_of, "2026-03-04");
    assert.deepEqual(repository.calls.balanceInputs, [{ employeeId: E1, years: [2026] }]);
  });
});

test("GET /leave-balances: an employee cannot read a colleague's -- same team, other team, other department are all 404", async () => {
  for (const target of [E2, E_OTHER, TL_A, MANAGER]) {
    await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository(), async (app, repository) => {
      const response = await app.request("GET", `/api/v1/leave-balances?employee_id=${target}`);

      assert.equal(response.status, 404, target);
      assert.equal(repository.calls.balanceInputs.length, 0, target);
    });
  }
});

test("GET /leave-balances: a tl reads their own team and themselves, and gets 404 for another team or department", async () => {
  await withApp(principalFor("tl"), fakeLeaveRepository(), async (app) => {
    for (const target of [E1, TL_A]) {
      const response = await app.request("GET", `/api/v1/leave-balances?employee_id=${target}`);
      assert.equal(response.status, 200, target);
      assert.equal(response.body.data.employee_id, target);
    }
    for (const target of [E2, TL_B, E_OTHER, MANAGER]) {
      assert.equal((await app.request("GET", `/api/v1/leave-balances?employee_id=${target}`)).status, 404, target);
    }
  });
});

test("GET /leave-balances: a manager reads their department -- both teams -- and gets 404 for another department", async () => {
  await withApp(principalFor("manager"), fakeLeaveRepository(), async (app) => {
    for (const target of [E1, E2, TL_A, TL_B, MANAGER]) {
      assert.equal((await app.request("GET", `/api/v1/leave-balances?employee_id=${target}`)).status, 200, target);
    }
    assert.equal((await app.request("GET", `/api/v1/leave-balances?employee_id=${E_OTHER}`)).status, 404);
  });
});

test("GET /leave-balances: admin and hr read any employee, in any department", async () => {
  for (const role of ["admin", "hr"]) {
    await withApp(principalFor(role), fakeLeaveRepository(), async (app) => {
      for (const target of [E1, E2, E_OTHER, TL_A, MANAGER]) {
        const response = await app.request("GET", `/api/v1/leave-balances?employee_id=${target}`);
        assert.equal(response.status, 200, `${role} ${target}`);
        assert.equal(response.body.data.employee_id, target);
      }
    });
  }
});

test("GET /leave-balances: an unknown employee_id is the same 404 as an out-of-scope one", async () => {
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository(), async (app) => {
    const unknown = await app.request("GET", `/api/v1/leave-balances?employee_id=${randomUUID()}`);
    const outOfScope = await app.request("GET", `/api/v1/leave-balances?employee_id=${E_OTHER}`);

    assert.equal(unknown.status, 404);
    assert.equal(outOfScope.status, 404);
    // Everything but the per-request id is identical, so the response never confirms an id exists.
    assert.equal(unknown.body.error.code, outOfScope.body.error.code);
    assert.equal(unknown.body.error.message, outOfScope.body.error.message);
  });
});

test("GET /leave-balances: a bad query is 400 -- a malformed employee_id, a bad as_of, an unknown parameter", async () => {
  await withApp(principalFor("admin"), fakeLeaveRepository(), async (app) => {
    for (const query of ["employee_id=nope", "as_of=2026-02-30", "as_of=yesterday", "year=2026", "employee_id="]) {
      assert.equal((await app.request("GET", `/api/v1/leave-balances?${query}`)).status, 400, query);
    }
  });
});

test("GET /leave-balances: the body is the two pools for as_of's month and year, with the type map and Maternity on no pool", async () => {
  const usage = [usageRow("Annual", 2026, 3, 1, 1), usageRow("Sick", 2026, 2, 3), usageRow("Maternity", 2026, 3, 31)];
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository([], { usage }), async (app) => {
    const { body } = await app.request("GET", "/api/v1/leave-balances?as_of=2026-03-20");

    assert.deepEqual(body.data.pools.monthly, { period: { year: 2026, month: 3 }, entitlement: 2, approved: 1, pending: 1, remaining: 0 });
    assert.deepEqual(body.data.pools.serious_need, { period: { year: 2026 }, entitlement: 14, approved: 3, pending: 0, remaining: 11 });
    assert.equal(body.data.types.Maternity, null);
    assert.equal(body.data.types.Annual, "monthly");
    assert.equal(body.data.types.Emergency, "serious_need");
  });
});

test("GET /leave-balances: December reports an allowance of 12", async () => {
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository(), async (app) => {
    const { body } = await app.request("GET", "/api/v1/leave-balances?as_of=2026-12-05");
    assert.equal(body.data.pools.monthly.entitlement, 12);
  });
});

test("GET /leave-balances is its own path: /leaves/balance is a malformed id on the read router, not the balance", async () => {
  await withApp(principalFor("employee", { employeeId: E1 }), fakeLeaveRepository(), async (app) => {
    const response = await app.request("GET", "/api/v1/leaves/balance");
    assert.equal(response.status, 404);
  });
});
