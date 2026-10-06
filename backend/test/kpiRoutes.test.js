import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createKpiMutationService } from "../src/services/kpiMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The scope matrix lives in kpiAuthorization.test.js and the orchestration in
// kpiMutationService.test.js; these tests prove the real kpiMutationService and authorization are
// wired to real HTTP status codes and bodies, that the strict schemas guard the door, and that the
// rating endpoint behaves as D29 settled -- against fake repositories (no database).
//
// The two rating bans are DATABASE constraints. A fake repository cannot prove the database
// refuses; it can only mirror the refusal so the HTTP mapping is exercised (the 403 and the 409
// reach the client intact, and the service does not get in their way). The real refusals are
// proved against Postgres by scripts/e2e-projects-kpis.js, and the SQL-error -> HttpError
// translation by kpiRepository.test.js.

const D1 = randomUUID();
const D2 = randomUUID();
const TL_A = randomUUID();
const TL_B = randomUUID();
const E1 = randomUUID();        // employee on TL_A's team
const E2 = randomUUID();        // employee on TL_B's team
const E_OTHER = randomUUID();   // employee in the other department
const E_TERM = randomUUID();    // terminated employee
const PROJECT = randomUUID();

const employee = (id, role, departmentId, teamLeadId = null, status = "active") => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: status,
});
const EMPLOYEES = [
  employee(TL_A, "tl", D1), employee(TL_B, "tl", D1),
  employee(E1, "employee", D1, TL_A), employee(E2, "employee", D1, TL_B),
  employee(E_OTHER, "employee", D2), employee(E_TERM, "employee", D1, TL_A, "terminated"),
];

function principalFor(role, overrides = {}) {
  return {
    userId: randomUUID(), employeeId: role === "tl" ? TL_A : randomUUID(), role, departmentId: D1, ...overrides,
  };
}

// A project led by TL_A with one member of TL_A's team on it.
const PROJECTS = [{ id: PROJECT, department_id: D1, team_lead_id: TL_A, assignees: [{ id: E1, team_lead_id: TL_A }] }];

function kpiRow(overrides = {}) {
  return {
    id: randomUUID(), project_id: PROJECT, employee_id: E1,
    employee_department_id: D1, employee_team_lead_id: TL_A,
    project_department_id: D1, project_team_lead_id: TL_A, project_assignee_team_lead_ids: [TL_A],
    ...overrides,
  };
}

/**
 * Mirrors the real repository's contract. `rate` mirrors the two database CHECKs -- a project-less
 * KPI is refused 409 and a rater equal to the KPI's employee is refused 403 -- so the HTTP mapping
 * of the real refusals is exercised; it is a mirror, not the proof (see the header).
 */
function fakeKpiRepository(seed = []) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], rate: [], deleteById: [] };
  return {
    calls,
    async findByIdForWrite(id) { return byId.get(id) ?? null; },
    async create(input) { calls.create.push(input); return { id: randomUUID(), ...input }; },
    async updateById(id, changes) { calls.updateById.push({ id, changes }); return { id, ...changes }; },
    async rate(id, { rating, ratedByEmployeeId }) {
      calls.rate.push({ id, rating, ratedByEmployeeId });
      const row = byId.get(id);
      if (row.project_id === null) {
        throw new HttpError(409, "legacy_kpi_not_rateable", "A KPI with no project cannot be rated.");
      }
      if (ratedByEmployeeId === row.employee_id) {
        throw new HttpError(403, "self_rating_denied", "You cannot rate your own KPI.");
      }
      return { id, rating, rated_by_employee_id: ratedByEmployeeId };
    },
    async deleteById(id, deletedBy) { calls.deleteById.push({ id, deletedBy }); },
  };
}

async function startApp(principal, kpiRepository, { readRepository } = {}) {
  const kpiMutationService = createKpiMutationService({
    kpiRepository,
    projectRepository: { async findByIdForWrite(id) { return PROJECTS.find((row) => row.id === id) ?? null; } },
    employeeRepository: { async findById(id) { return EMPLOYEES.find((row) => row.id === id) ?? null; } },
  });
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: readRepository ? { kpiRepository: readRepository } : {},
    kpiMutationService,
  });
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
async function withApp(principal, repository, fn, options) {
  const app = await startApp(principal, repository, options);
  try {
    return await fn(app, repository);
  } finally {
    await app.close();
  }
}

const VALID_CREATE_BODY = Object.freeze({
  project_id: PROJECT, employee_id: E1, title: "Ship it", target: 100, weight: 50, period: "Q1",
});

const WRITER_ROLES = new Set(["admin", "hr", "manager", "tl"]);

// ---------------------------------------------------------------------------
// Every role against each operation
// ---------------------------------------------------------------------------

test("POST /kpis: admin, hr, manager and tl create (201); employee is denied (403)", async () => {
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeKpiRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/kpis", VALID_CREATE_BODY);
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 201, role);
        assert.equal(repository.calls.create.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.create.length, 0, role);
      }
    });
  }
});

test("PATCH /kpis/:id: admin, hr, manager and tl update (200); employee is denied (403)", async () => {
  const target = kpiRow();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, { current_value: 5 });
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(repository.calls.updateById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.updateById.length, 0, role);
      }
    });
  }
});

test("POST /kpis/:id/rating: admin, hr, manager and tl rate (200); employee is denied (403)", async () => {
  const target = kpiRow();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 8 });
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(response.body.data.rating, 8, role);
        assert.equal(repository.calls.rate.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.rate.length, 0, role);
      }
    });
  }
});

test("DELETE /kpis/:id: admin, hr, manager and tl delete (204); employee is denied (403)", async () => {
  const target = kpiRow();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("DELETE", `/api/v1/kpis/${target.id}`);
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 204, role);
        assert.equal(repository.calls.deleteById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(repository.calls.deleteById.length, 0, role);
      }
    });
  }
});

test("DELETE: the repository receives the acting principal's employee id as the deleter", async () => {
  const target = kpiRow();
  const principal = principalFor("hr");
  await withApp(principal, fakeKpiRepository([target]), async (app, repository) => {
    const response = await app.request("DELETE", `/api/v1/kpis/${target.id}`);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.deepEqual(repository.calls.deleteById, [{ id: target.id, deletedBy: principal.employeeId }]);
  });
});

// ---------------------------------------------------------------------------
// Scope over HTTP
// ---------------------------------------------------------------------------

test("a manager is denied (403 kpi_scope_denied) on every write for a KPI whose project is in another department", async () => {
  const target = kpiRow({ project_department_id: D2 });
  await withApp(principalFor("manager"), fakeKpiRepository([target]), async (app, repository) => {
    for (const response of [
      await app.request("PATCH", `/api/v1/kpis/${target.id}`, { title: "x" }),
      await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 5 }),
      await app.request("DELETE", `/api/v1/kpis/${target.id}`),
    ]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "kpi_scope_denied");
    }
    assert.equal(repository.calls.updateById.length + repository.calls.rate.length + repository.calls.deleteById.length, 0);
  });
});

test("a tl is denied (403) for a KPI whose employee is on another team, and may write one whose employee is on theirs", async () => {
  const offTeam = kpiRow({ employee_id: E2, employee_team_lead_id: TL_B });
  const onTeam = kpiRow();
  await withApp(principalFor("tl"), fakeKpiRepository([offTeam, onTeam]), async (app, repository) => {
    assert.equal((await app.request("PATCH", `/api/v1/kpis/${offTeam.id}`, { title: "x" })).status, 403);
    assert.equal((await app.request("POST", `/api/v1/kpis/${offTeam.id}/rating`, { rating: 5 })).status, 403);
    assert.equal((await app.request("PATCH", `/api/v1/kpis/${onTeam.id}`, { title: "x" })).status, 200);
    assert.equal(repository.calls.updateById.length, 1);
    assert.equal(repository.calls.rate.length, 0);
  });
});

test("POST: an out-of-scope caller gets the scope answer, not an eligibility one", async () => {
  // E_OTHER is in another department; a manager of D1 must be told 403, which reveals nothing.
  await withApp(principalFor("manager"), fakeKpiRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, employee_id: E_OTHER });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "kpi_scope_denied");
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("POST: current_value defaults to 0 and status to active", async () => {
  await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
    const response = await app.request("POST", "/api/v1/kpis", VALID_CREATE_BODY);
    assert.equal(response.status, 201);
    assert.equal(repository.calls.create[0].current_value, 0);
    assert.equal(repository.calls.create[0].status, "active");
  });
});

test("POST: an unknown project or employee is a 400, and an ineligible employee is a 400 employee_not_eligible", async () => {
  await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
    const unknownProject = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, project_id: randomUUID() });
    assert.equal(unknownProject.status, 400);
    assert.equal(unknownProject.body.error.code, "invalid_project");

    const unknownEmployee = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, employee_id: randomUUID() });
    assert.equal(unknownEmployee.status, 400);
    assert.equal(unknownEmployee.body.error.code, "invalid_employee");

    for (const ineligible of [E_TERM, TL_A, E_OTHER]) {
      const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, employee_id: ineligible });
      assert.equal(response.status, 400, ineligible);
      assert.equal(response.body.error.code, "employee_not_eligible", ineligible);
    }
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST: a project is required -- a null project_id, and so a new legacy KPI, is refused", async () => {
  await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
    const { project_id: _omitted, ...withoutProject } = VALID_CREATE_BODY;
    assert.equal((await app.request("POST", "/api/v1/kpis", withoutProject)).status, 400, "missing");
    assert.equal((await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, project_id: null })).status, 400, "null");
    assert.equal(repository.calls.create.length, 0);
  });
});

test("POST: project_id, employee_id, title, target, weight and period are required", async () => {
  for (const missing of ["project_id", "employee_id", "title", "target", "weight", "period"]) {
    const body = { ...VALID_CREATE_BODY };
    delete body[missing];
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app) => {
      assert.equal((await app.request("POST", "/api/v1/kpis", body)).status, 400, missing);
    });
  }
});

test("POST: server-owned, rating and unknown fields are rejected outright, not silently ignored", async () => {
  const forbidden = {
    id: randomUUID(), rating: 9, rated_by_employee_id: randomUUID(), rated_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", deleted_at: null,
    deleted_by_employee_id: randomUUID(), current: 5, unexpected: true,
  };
  for (const [key, value] of Object.entries(forbidden)) {
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, [key]: value });
      assert.equal(response.status, 400, key);
      assert.equal(response.body.error.code, "invalid_request", key);
      assert.equal(repository.calls.create.length, 0, key);
    });
  }
});

test("POST: malformed titles, periods, weights, statuses and ids are rejected", async () => {
  const bad = [
    { title: "" }, { title: "   " }, { title: "x".repeat(201) },
    { period: "" }, { period: "x".repeat(41) },
    { weight: 0 }, { weight: 101 }, { weight: 1.5 }, { weight: "50" },
    { status: "paused" }, { status: "Active" },
    { project_id: "not-a-uuid" }, { employee_id: "not-a-uuid" },
  ];
  for (const override of bad) {
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    });
  }
});

test("POST: boundary weights are accepted -- 1 and 100", async () => {
  for (const weight of [1, 100]) {
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app) => {
      assert.equal((await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, weight })).status, 201, String(weight));
    });
  }
});

// ---------------------------------------------------------------------------
// Amounts (D29: two decimals within numeric(14,2), JSON numbers)
// ---------------------------------------------------------------------------

test("POST: malformed amounts are rejected -- zero target, negative, string, null, too many decimals, too large, exponent form", async () => {
  const bad = [
    { target: 0 }, { target: -1 },
    { current_value: -0.01 },
    { target: "100" }, { current_value: "5" },
    { target: null }, { current_value: null },
    { target: 100.123 }, { current_value: 0.30000000000000004 },
    { target: 1e-7 }, { current_value: 1e-7 },
    { target: 1e12 }, { target: 1e21 },
  ];
  for (const override of bad) {
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    });
  }
});

test("POST: boundary amounts are accepted -- a cent, two decimals, zero progress, and the numeric(14,2) maximum", async () => {
  const good = [{ target: 0.01 }, { target: 1234.56 }, { current_value: 0 }, { current_value: 99.9 }, { target: 999999999999.99 }];
  for (const override of good) {
    await withApp(principalFor("admin"), fakeKpiRepository(), async (app) => {
      const response = await app.request("POST", "/api/v1/kpis", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 201, JSON.stringify(override));
    });
  }
});

test("PATCH: the same amount rules apply to a progress edit", async () => {
  const target = kpiRow();
  const bad = [{ target: 0 }, { current_value: -1 }, { target: 1.234 }, { current_value: "5" }, { weight: 0 }, { status: "done" }];
  for (const body of bad) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    });
  }
});

// ---------------------------------------------------------------------------
// Update: employee_id and project_id are frozen
// ---------------------------------------------------------------------------

test("PATCH: progress fields are accepted and reach the repository exactly as given", async () => {
  const target = kpiRow();
  await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
    const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, {
      title: "Renamed", target: 200, current_value: 12.5, weight: 40, period: "Q2", status: "active",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(repository.calls.updateById[0].changes, {
      title: "Renamed", target: 200, current_value: 12.5, weight: 40, period: "Q2", status: "active",
    });
  });
});

test("PATCH: D29 -- employee_id and project_id are frozen; either is a 400 and nothing is written", async () => {
  const target = kpiRow();
  for (const body of [{ employee_id: E2 }, { project_id: randomUUID() }, { title: "x", employee_id: E2 }, { title: "x", project_id: PROJECT }]) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid_request", JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    });
  }
});

test("PATCH: the rating has its own endpoint -- rating, rater and time are all refused here", async () => {
  const target = kpiRow();
  for (const body of [{ rating: 5 }, { rated_by_employee_id: E2 }, { rated_at: "2026-01-01T00:00:00Z" }, { title: "x", rating: 5 }]) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length + repository.calls.rate.length, 0, JSON.stringify(body));
    });
  }
});

test("PATCH: server-owned and unknown fields are rejected, and an empty body is rejected", async () => {
  const target = kpiRow();
  const bodies = [
    { id: randomUUID() }, { created_at: "2026-01-01T00:00:00Z" }, { updated_at: "2026-01-01T00:00:00Z" },
    { deleted_at: null }, { deleted_by_employee_id: randomUUID() }, { current: 5 }, { unexpected: true }, {},
  ];
  for (const body of bodies) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/kpis/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    });
  }
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

test("POST /kpis/:id/rating: the rater is the acting principal, and the response carries the rating", async () => {
  const target = kpiRow();
  const principal = principalFor("manager");
  await withApp(principal, fakeKpiRepository([target]), async (app, repository) => {
    const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 9 });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.rating, 9);
    assert.deepEqual(repository.calls.rate, [{ id: target.id, rating: 9, ratedByEmployeeId: principal.employeeId }]);
  });
});

test("POST /kpis/:id/rating: the body is {rating} and nothing else -- a client can never say who rated or when", async () => {
  const target = kpiRow();
  for (const extra of [{ rated_by_employee_id: E2 }, { rated_at: "2026-01-01T00:00:00Z" }, { title: "x" }, { employee_id: E2 }, { ratedBy: E2 }]) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 7, ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal(repository.calls.rate.length, 0, JSON.stringify(extra));
    });
  }
});

test("POST /kpis/:id/rating: the rating must be a whole number from 1 to 10", async () => {
  const target = kpiRow();
  for (const rating of [0, 11, -1, 7.5, "7", null, true, [7], {}]) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
      const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating });
      assert.equal(response.status, 400, JSON.stringify(rating));
      assert.equal(repository.calls.rate.length, 0, JSON.stringify(rating));
    });
  }
  // An empty body, and a missing one.
  await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app) => {
    assert.equal((await app.request("POST", `/api/v1/kpis/${target.id}/rating`, {})).status, 400);
  });
});

test("POST /kpis/:id/rating: the boundaries 1 and 10 are accepted", async () => {
  const target = kpiRow();
  for (const rating of [1, 10]) {
    await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app) => {
      assert.equal((await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating })).status, 200, String(rating));
    });
  }
});

test("POST /kpis/:id/rating: D29 -- a self-rating reaches the database's constraint and comes back 403 self_rating_denied", async () => {
  // The KPI's employee has become a manager in the same department and rates their own KPI: in
  // scope, so authorized -- the service does not refuse it; kpis_no_self_rating does.
  const selfRater = principalFor("manager");
  const target = kpiRow({ employee_id: selfRater.employeeId });
  await withApp(selfRater, fakeKpiRepository([target]), async (app, repository) => {
    const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 10 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "self_rating_denied");
    assert.equal(repository.calls.rate.length, 1, "the request reached the repository -- the service did not pre-empt the ban");
  });
});

test("POST /kpis/:id/rating: D29 -- a legacy KPI reaches the database's constraint and comes back 409 legacy_kpi_not_rateable", async () => {
  const legacy = kpiRow({
    project_id: null, project_department_id: null, project_team_lead_id: null, project_assignee_team_lead_ids: [],
  });
  await withApp(principalFor("admin"), fakeKpiRepository([legacy]), async (app, repository) => {
    const response = await app.request("POST", `/api/v1/kpis/${legacy.id}/rating`, { rating: 5 });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "legacy_kpi_not_rateable");
    assert.equal(repository.calls.rate.length, 1, "the request reached the repository -- the service did not pre-empt the ban");
  });
});

test("POST /kpis/:id/rating: a rater out of scope is refused 403 kpi_scope_denied before the database is asked", async () => {
  const target = kpiRow({ project_department_id: D2 });
  await withApp(principalFor("manager"), fakeKpiRepository([target]), async (app, repository) => {
    const response = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 5 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "kpi_scope_denied");
    assert.equal(repository.calls.rate.length, 0);
  });
});

test("POST /kpis/:id/rating: a legacy KPI is still scope-checked -- a manager of another department cannot even reach the ban", async () => {
  const legacyElsewhere = kpiRow({
    project_id: null, project_department_id: null, project_team_lead_id: null, project_assignee_team_lead_ids: [],
    employee_department_id: D2,
  });
  await withApp(principalFor("manager"), fakeKpiRepository([legacyElsewhere]), async (app, repository) => {
    const response = await app.request("POST", `/api/v1/kpis/${legacyElsewhere.id}/rating`, { rating: 5 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "kpi_scope_denied");
    assert.equal(repository.calls.rate.length, 0);
  });
});

test("errors without details keep their original shape -- no stray details key", async () => {
  await withApp(principalFor("employee"), fakeKpiRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/kpis", VALID_CREATE_BODY);
    assert.equal(response.status, 403);
    assert.equal(Object.hasOwn(response.body.error, "details"), false);
  });
});

// ---------------------------------------------------------------------------
// Routing and ids
// ---------------------------------------------------------------------------

test("the write router does not shadow the read router: GET /kpis/:id still answers from the read repository", async () => {
  const target = kpiRow();
  const readRepository = {
    async listForPrincipal() { return []; },
    async findByIdForPrincipal(id) { return { id, title: "from the read repository" }; },
  };
  await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app) => {
    const read = await app.request("GET", `/api/v1/kpis/${target.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.title, "from the read repository");

    // ...and the rating route on the same path prefix is still reachable.
    const rated = await app.request("POST", `/api/v1/kpis/${target.id}/rating`, { rating: 6 });
    assert.equal(rated.status, 200);
  }, { readRepository });
});

test("rating is POST only -- PUT and PATCH on /rating are not routes, so the CORS method list never had to change", async () => {
  const target = kpiRow();
  await withApp(principalFor("admin"), fakeKpiRepository([target]), async (app, repository) => {
    assert.equal((await app.request("PUT", `/api/v1/kpis/${target.id}/rating`, { rating: 6 })).status, 404);
    assert.equal((await app.request("PATCH", `/api/v1/kpis/${target.id}/rating`, { rating: 6 })).status, 404);
    assert.equal(repository.calls.rate.length, 0);
  });
});

test("PATCH, DELETE and rating: a malformed id is a 404, matching the read path's convention", async () => {
  await withApp(principalFor("admin"), fakeKpiRepository(), async (app, repository) => {
    assert.equal((await app.request("PATCH", "/api/v1/kpis/not-a-uuid", { title: "x" })).status, 404);
    assert.equal((await app.request("DELETE", "/api/v1/kpis/not-a-uuid")).status, 404);
    assert.equal((await app.request("POST", "/api/v1/kpis/not-a-uuid/rating", { rating: 5 })).status, 404);
    assert.equal(repository.calls.updateById.length + repository.calls.deleteById.length + repository.calls.rate.length, 0);
  });
});

test("PATCH, DELETE and rating: a well-formed but nonexistent id is a 404", async () => {
  await withApp(principalFor("admin"), fakeKpiRepository([]), async (app) => {
    assert.equal((await app.request("PATCH", `/api/v1/kpis/${randomUUID()}`, { title: "x" })).status, 404);
    assert.equal((await app.request("DELETE", `/api/v1/kpis/${randomUUID()}`)).status, 404);
    assert.equal((await app.request("POST", `/api/v1/kpis/${randomUUID()}/rating`, { rating: 5 })).status, 404);
  });
});
