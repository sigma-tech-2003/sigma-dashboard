import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createProjectMutationService } from "../src/services/projectMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The scope predicates live in projectAuthorization.test.js and the orchestration in
// projectMutationService.test.js; these tests prove the real projectMutationService and
// authorization are wired to real HTTP status codes and bodies, and that the strict schemas guard
// the door -- against fake repositories (no database). The repository's own SQL (the replace-set,
// the lock-then-count order, the status/date formatting) is projectRepository.test.js's job and
// scripts/e2e-projects-kpis.js's.

const D1 = randomUUID();
const D2 = randomUUID();
const TL_A = randomUUID();
const TL_B = randomUUID();
const E1 = randomUUID();        // employee on TL_A's team
const E2 = randomUUID();        // employee on TL_B's team
const E3 = randomUUID();        // another employee on TL_A's team
const E_OTHER = randomUUID();   // employee in the other department
const E_TERM = randomUUID();    // terminated employee
const TL_OTHER = randomUUID();  // team lead in the other department

const employee = (id, role, departmentId, teamLeadId = null, status = "active") => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: status,
});
const EMPLOYEES = [
  employee(TL_A, "tl", D1), employee(TL_B, "tl", D1), employee(TL_OTHER, "tl", D2),
  employee(E1, "employee", D1, TL_A), employee(E2, "employee", D1, TL_B), employee(E3, "employee", D1, TL_A),
  employee(E_OTHER, "employee", D2), employee(E_TERM, "employee", D1, TL_A, "terminated"),
];

function principalFor(role, overrides = {}) {
  return {
    userId: randomUUID(), employeeId: role === "tl" ? TL_A : randomUUID(), role, departmentId: D1,
    isTeamLead: role === "tl", ...overrides,
  };
}

// Led by TL_A, with one member of TL_A's team on it.
function projectRecord(overrides = {}) {
  return {
    id: randomUUID(), department_id: D1, team_lead_id: TL_A, title: "Launch", assignees: [{ id: E1, team_lead_id: TL_A }],
    ...overrides,
  };
}

/**
 * Mirrors the real repository's contract: findByIdForWrite returns the project with its assignees;
 * updateById and deleteById can be told to refuse with the same 409 (and details) the real
 * repository raises while live KPIs exist, so the HTTP mapping of those refusals is exercised.
 */
function fakeProjectRepository(seed = [], { updateRefusal = null, deleteRefusal = null } = {}) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async findByIdForWrite(id) { return byId.get(id) ?? null; },
    async create(input) { calls.create.push(input); return { id: randomUUID(), ...input }; },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      if (updateRefusal) throw updateRefusal;
      return byId.has(id) ? { ...byId.get(id), ...changes } : null;
    },
    async deleteById(id, deletedBy) {
      calls.deleteById.push({ id, deletedBy });
      if (deleteRefusal) throw deleteRefusal;
    },
  };
}

async function startApp(principal, repository) {
  const projectMutationService = createProjectMutationService({
    projectRepository: repository,
    employeeRepository: { async findById(id) { return EMPLOYEES.find((row) => row.id === id) ?? null; } },
  });
  const app = createApp({ verifyAccessToken: async () => principal, repositories: {}, projectMutationService });
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

const VALID_CREATE_BODY = Object.freeze({
  department_id: D1, team_lead_id: TL_A, title: "Launch", description: "First release",
  start_date: "2026-01-01", due_date: "2026-02-01", assigned_employee_ids: [E1],
});

const WRITER_ROLES = new Set(["admin", "hr", "manager", "tl"]);

// ---------------------------------------------------------------------------
// Every role against each of the three operations
// ---------------------------------------------------------------------------

test("POST /projects: admin, hr, manager and tl create (201); employee is denied (403)", async () => {
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", VALID_CREATE_BODY);
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

test("PATCH /projects/:id: admin, hr, manager and tl update (200); employee is denied (403)", async () => {
  const target = projectRecord();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { title: "Renamed" });
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(response.body.data.title, "Renamed", role);
        assert.equal(repository.calls.updateById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.updateById.length, 0, role);
      }
    });
  }
});

test("DELETE /projects/:id: admin, hr, manager and tl delete (204); employee is denied (403)", async () => {
  const target = projectRecord();
  for (const role of USER_ROLES) {
    await withApp(principalFor(role), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("DELETE", `/api/v1/projects/${target.id}`);
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
  const target = projectRecord();
  const principal = principalFor("hr");
  await withApp(principal, fakeProjectRepository([target]), async (app, repository) => {
    const response = await app.request("DELETE", `/api/v1/projects/${target.id}`);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.deepEqual(repository.calls.deleteById, [{ id: target.id, deletedBy: principal.employeeId }]);
  });
});

// ---------------------------------------------------------------------------
// D29: status defaults to active
// ---------------------------------------------------------------------------

test("POST: status defaults to active -- parity with the frontend form, not the column's draft", async () => {
  await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
    const response = await app.request("POST", "/api/v1/projects", VALID_CREATE_BODY);
    assert.equal(response.status, 201);
    assert.equal(repository.calls.create[0].status, "active");
  });
});

test("POST: an explicit status is honored -- draft, active and completed", async () => {
  for (const status of ["draft", "active", "completed"]) {
    await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, status });
      assert.equal(response.status, 201, status);
      assert.equal(repository.calls.create[0].status, status, status);
    });
  }
});

test("PATCH: a project's status may move between any of draft, active and completed", async () => {
  const target = projectRecord();
  await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
    for (const status of ["completed", "draft", "active"]) {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { status });
      assert.equal(response.status, 200, status);
    }
    assert.deepEqual(repository.calls.updateById.map((call) => call.changes.status), ["completed", "draft", "active"]);
  });
});

test("POST: description may be omitted or empty, and is trimmed", async () => {
  await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
    const { description: _omitted, ...withoutDescription } = VALID_CREATE_BODY;
    assert.equal((await app.request("POST", "/api/v1/projects", withoutDescription)).status, 201);
    assert.equal((await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, description: "  padded  " })).status, 201);
    assert.deepEqual(repository.calls.create.map((call) => call.description), ["", "padded"]);
  });
});

// ---------------------------------------------------------------------------
// D29: scoped-role defaults -- present values are checked, never overridden
// ---------------------------------------------------------------------------

test("POST: a tl's department and lead default to their own; a manager's department does", async () => {
  const body = { title: "Launch", start_date: "2026-01-01", due_date: "2026-02-01", assigned_employee_ids: [E1] };

  await withApp(principalFor("tl"), fakeProjectRepository(), async (app, repository) => {
    assert.equal((await app.request("POST", "/api/v1/projects", body)).status, 201);
    assert.equal(repository.calls.create[0].department_id, D1);
    assert.equal(repository.calls.create[0].team_lead_id, TL_A);
  });

  await withApp(principalFor("manager"), fakeProjectRepository(), async (app, repository) => {
    assert.equal((await app.request("POST", "/api/v1/projects", body)).status, 201);
    assert.equal(repository.calls.create[0].department_id, D1);
    assert.equal(repository.calls.create[0].team_lead_id, null);
  });
});

test("POST: a tl naming another lead, or an explicit null, is refused with 403 -- not rewritten to themselves", async () => {
  for (const lead of [TL_B, null]) {
    await withApp(principalFor("tl"), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, team_lead_id: lead });
      assert.equal(response.status, 403, String(lead));
      assert.equal(response.body.error.code, "project_scope_denied", String(lead));
      assert.equal(repository.calls.create.length, 0, String(lead));
    });
  }
});

test("POST: admin and hr must name a department -- there is nothing to default it to", async () => {
  const { department_id: _omitted, ...body } = VALID_CREATE_BODY;
  await withApp(principalFor("admin"), fakeProjectRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/projects", body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
  });
});

// ---------------------------------------------------------------------------
// D29: the two-sided TL scope, over HTTP, in both directions
// ---------------------------------------------------------------------------

test("TL, existing side: a tl with no stake in a project can neither edit nor delete it (403)", async () => {
  const target = projectRecord();
  await withApp(principalFor("tl", { employeeId: TL_B }), fakeProjectRepository([target]), async (app, repository) => {
    const edit = await app.request("PATCH", `/api/v1/projects/${target.id}`, { title: "x" });
    const remove = await app.request("DELETE", `/api/v1/projects/${target.id}`);
    for (const response of [edit, remove]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "project_scope_denied");
    }
    assert.equal(repository.calls.updateById.length + repository.calls.deleteById.length, 0);
  });
});

test("TL, resulting side: a tl cannot add an assignee from another team to a project they lead (403)", async () => {
  const target = projectRecord();
  await withApp(principalFor("tl"), fakeProjectRepository([target]), async (app, repository) => {
    const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E1, E2] });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "project_scope_denied");
    assert.equal(repository.calls.updateById.length, 0);

    // Staying within their own team is fine.
    const allowed = await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E1, E3] });
    assert.equal(allowed.status, 200);
  });
});

test("TL: a tl who is not the lead but has a member on the project can DELETE it (204) yet not EDIT it (403)", async () => {
  const target = projectRecord({
    team_lead_id: TL_B, assignees: [{ id: E1, team_lead_id: TL_A }, { id: E2, team_lead_id: TL_B }],
  });
  await withApp(principalFor("tl"), fakeProjectRepository([target]), async (app, repository) => {
    const edit = await app.request("PATCH", `/api/v1/projects/${target.id}`, { title: "x" });
    assert.equal(edit.status, 403);
    assert.equal(repository.calls.updateById.length, 0);

    const remove = await app.request("DELETE", `/api/v1/projects/${target.id}`);
    assert.equal(remove.status, 204);
    assert.equal(repository.calls.deleteById.length, 1);
  });
});

test("TL: a tl cannot hand a project they lead to another lead, or clear the lead (403)", async () => {
  const target = projectRecord();
  for (const lead of [TL_B, null]) {
    await withApp(principalFor("tl"), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { team_lead_id: lead });
      assert.equal(response.status, 403, String(lead));
      assert.equal(repository.calls.updateById.length, 0, String(lead));
    });
  }
});

test("manager: cannot touch another department's project, nor move their own into another department (403)", async () => {
  const foreign = projectRecord({ department_id: D2, team_lead_id: null, assignees: [] });
  await withApp(principalFor("manager"), fakeProjectRepository([foreign]), async (app) => {
    assert.equal((await app.request("PATCH", `/api/v1/projects/${foreign.id}`, { title: "x" })).status, 403);
    assert.equal((await app.request("DELETE", `/api/v1/projects/${foreign.id}`)).status, 403);
  });

  const own = projectRecord();
  await withApp(principalFor("manager"), fakeProjectRepository([own]), async (app, repository) => {
    const move = await app.request("PATCH", `/api/v1/projects/${own.id}`, {
      department_id: D2, team_lead_id: null, assigned_employee_ids: [E_OTHER],
    });
    assert.equal(move.status, 403);
    assert.equal(repository.calls.updateById.length, 0);
  });
});

test("admin and hr may move a project across departments (200)", async () => {
  const target = projectRecord();
  for (const role of ["admin", "hr"]) {
    await withApp(principalFor(role), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, {
        department_id: D2, team_lead_id: TL_OTHER, assigned_employee_ids: [E_OTHER],
      });
      assert.equal(response.status, 200, role);
      assert.equal(repository.calls.updateById[0].changes.department_id, D2, role);
    });
  }
});

// ---------------------------------------------------------------------------
// D29: assignees are an atomic replace-set with at least one and no duplicates
// ---------------------------------------------------------------------------

test("PATCH: assigned_employee_ids reaches the repository whole, as the replace-set", async () => {
  const target = projectRecord();
  await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
    const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E1, E3] });
    assert.equal(response.status, 200);
    assert.deepEqual(repository.calls.updateById[0].changes, { assigned_employee_ids: [E1, E3] });
  });
});

test("POST and PATCH: at least one assignee is required, and an empty list is refused", async () => {
  const target = projectRecord();
  await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
    const { assigned_employee_ids: _omitted, ...withoutAssignees } = VALID_CREATE_BODY;
    assert.equal((await app.request("POST", "/api/v1/projects", withoutAssignees)).status, 400, "missing on create");
    assert.equal((await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, assigned_employee_ids: [] })).status, 400, "empty on create");
    assert.equal((await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [] })).status, 400, "empty on update");
    assert.equal(repository.calls.create.length + repository.calls.updateById.length, 0);
  });
});

test("POST and PATCH: the same employee cannot be assigned twice", async () => {
  const target = projectRecord();
  await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
    assert.equal((await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, assigned_employee_ids: [E1, E1] })).status, 400);
    assert.equal((await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E1, E3, E1] })).status, 400);
    assert.equal(repository.calls.create.length + repository.calls.updateById.length, 0);
  });
});

test("POST and PATCH: an assignee must exist, be active, be an employee, and work in the project's department (400)", async () => {
  const target = projectRecord();
  for (const assignee of [randomUUID(), E_TERM, TL_A, E_OTHER]) {
    await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
      const create = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, assigned_employee_ids: [E1, assignee] });
      assert.equal(create.status, 400, assignee);
      assert.equal(create.body.error.code, "invalid_assignee", assignee);

      const update = await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E1, assignee] });
      assert.equal(update.status, 400, assignee);
      assert.equal(update.body.error.code, "invalid_assignee", assignee);
      assert.equal(repository.calls.create.length + repository.calls.updateById.length, 0, assignee);
    });
  }
});

test("a lead must be an active tl in the project's department (400)", async () => {
  for (const lead of [randomUUID(), E1, TL_OTHER]) {
    await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, team_lead_id: lead });
      assert.equal(response.status, 400, lead);
      assert.equal(response.body.error.code, "invalid_team_lead", lead);
      assert.equal(repository.calls.create.length, 0, lead);
    });
  }
});

test("PATCH: a department change must restate the lead and the assignees; the lead may be null", async () => {
  const target = projectRecord();
  await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
    const refused = [
      { department_id: D2 },
      { department_id: D2, team_lead_id: null },
      { department_id: D2, assigned_employee_ids: [E_OTHER] },
    ];
    for (const body of refused) {
      assert.equal((await app.request("PATCH", `/api/v1/projects/${target.id}`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(repository.calls.updateById.length, 0);

    const allowed = await app.request("PATCH", `/api/v1/projects/${target.id}`, {
      department_id: D2, team_lead_id: null, assigned_employee_ids: [E_OTHER],
    });
    assert.equal(allowed.status, 200);
  });
});

// ---------------------------------------------------------------------------
// D29: the 409s with counts
// ---------------------------------------------------------------------------

test("DELETE: a project that still has live KPIs is a 409 project_has_kpis whose body carries the count", async () => {
  const target = projectRecord();
  const refusal = new HttpError(409, "project_has_kpis", "This project still has 4 KPI(s); delete or move them before deleting it.", { live_kpi_count: 4 });
  await withApp(principalFor("admin"), fakeProjectRepository([target], { deleteRefusal: refusal }), async (app) => {
    const response = await app.request("DELETE", `/api/v1/projects/${target.id}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "project_has_kpis");
    assert.deepEqual(response.body.error.details, { live_kpi_count: 4 });
    assert.match(response.body.error.message, /\b4\b/);
    assert.ok(response.body.error.requestId, "the standard error envelope is intact");
  });
});

test("PATCH: removing an assignee who still has live KPIs is a 409 assignee_has_kpis whose body carries the count", async () => {
  const target = projectRecord();
  const refusal = new HttpError(409, "assignee_has_kpis", "An assignee being removed still has 2 KPI(s) on this project.", { live_kpi_count: 2 });
  await withApp(principalFor("admin"), fakeProjectRepository([target], { updateRefusal: refusal }), async (app) => {
    const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, { assigned_employee_ids: [E3] });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "assignee_has_kpis");
    assert.deepEqual(response.body.error.details, { live_kpi_count: 2 });
  });
});

test("errors without details keep their original shape -- no stray details key", async () => {
  await withApp(principalFor("employee"), fakeProjectRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/projects", VALID_CREATE_BODY);
    assert.equal(response.status, 403);
    assert.equal(Object.hasOwn(response.body.error, "details"), false);
  });
});

// ---------------------------------------------------------------------------
// Schema enforcement
// ---------------------------------------------------------------------------

test("POST: server-owned, legacy and unknown fields are rejected outright, not silently ignored", async () => {
  const forbidden = {
    id: randomUUID(), company_id: randomUUID(), name: "legacy name", assignedEmployeeIds: [E1],
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", deleted_at: null,
    deleted_by_employee_id: randomUUID(), unexpected: true,
  };
  for (const [key, value] of Object.entries(forbidden)) {
    await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, [key]: value });
      assert.equal(response.status, 400, key);
      assert.equal(response.body.error.code, "invalid_request", key);
      assert.equal(repository.calls.create.length, 0, key);
    });
  }
});

test("PATCH: server-owned, legacy and unknown fields are rejected, and an empty body is rejected", async () => {
  const target = projectRecord();
  const bodies = [
    { id: randomUUID() }, { company_id: randomUUID() }, { name: "x" }, { assignedEmployeeIds: [E1] },
    { created_at: "2026-01-01T00:00:00Z" }, { updated_at: "2026-01-01T00:00:00Z" }, { deleted_at: null },
    { deleted_by_employee_id: randomUUID() }, { unexpected: true }, {},
  ];
  for (const body of bodies) {
    await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    });
  }
});

test("POST: title, start_date, due_date and assigned_employee_ids are required", async () => {
  for (const missing of ["title", "start_date", "due_date", "assigned_employee_ids"]) {
    const body = { ...VALID_CREATE_BODY };
    delete body[missing];
    await withApp(principalFor("admin"), fakeProjectRepository(), async (app) => {
      assert.equal((await app.request("POST", "/api/v1/projects", body)).status, 400, missing);
    });
  }
});

test("POST: malformed titles, dates, statuses and ids are rejected", async () => {
  const bad = [
    { title: "" },
    { title: "   " },
    { title: "x".repeat(201) },
    { description: "x".repeat(2001) },
    { start_date: "2026-02-30" },        // not a real calendar date
    { start_date: "01/02/2026" },
    { due_date: "2026-01-01T00:00:00Z" },
    { due_date: "2025-12-31" },          // before start_date
    { status: "done" },
    { status: "Active" },
    { department_id: "not-a-uuid" },
    { team_lead_id: "not-a-uuid" },
    { assigned_employee_ids: ["not-a-uuid"] },
    { assigned_employee_ids: "not-an-array" },
  ];
  for (const override of bad) {
    await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
      const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    });
  }
});

test("POST: due_date on the same day as start_date is allowed", async () => {
  await withApp(principalFor("admin"), fakeProjectRepository(), async (app) => {
    const response = await app.request("POST", "/api/v1/projects", { ...VALID_CREATE_BODY, due_date: "2026-01-01" });
    assert.equal(response.status, 201);
  });
});

test("PATCH: dates, title and status are validated on a partial payload too", async () => {
  const target = projectRecord();
  const bad = [
    { title: "" }, { start_date: "2026-02-30" }, { status: "done" },
    { start_date: "2026-03-01", due_date: "2026-02-01" }, // both present and reversed
  ];
  for (const body of bad) {
    await withApp(principalFor("admin"), fakeProjectRepository([target]), async (app, repository) => {
      const response = await app.request("PATCH", `/api/v1/projects/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    });
  }
});

// ---------------------------------------------------------------------------
// id handling
// ---------------------------------------------------------------------------

test("PATCH and DELETE: a malformed id is a 404, matching the read path's convention", async () => {
  await withApp(principalFor("admin"), fakeProjectRepository(), async (app, repository) => {
    assert.equal((await app.request("PATCH", "/api/v1/projects/not-a-uuid", { title: "x" })).status, 404);
    assert.equal((await app.request("DELETE", "/api/v1/projects/not-a-uuid")).status, 404);
    assert.equal(repository.calls.updateById.length + repository.calls.deleteById.length, 0);
  });
});

test("PATCH and DELETE: a well-formed but nonexistent id is a 404", async () => {
  await withApp(principalFor("admin"), fakeProjectRepository([]), async (app) => {
    assert.equal((await app.request("PATCH", `/api/v1/projects/${randomUUID()}`, { title: "x" })).status, 404);
    assert.equal((await app.request("DELETE", `/api/v1/projects/${randomUUID()}`)).status, 404);
  });
});
