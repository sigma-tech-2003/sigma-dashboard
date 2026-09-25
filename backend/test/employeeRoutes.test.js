import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createEmployeeMutationService } from "../src/services/employeeMutationService.js";

// HTTP-level. The exhaustive role x operation matrix already lives in
// employeeAuthorization.test.js (pure, fast, no server) -- these tests prove the real
// employeeMutationService + employeeAuthorizationService are correctly wired to real HTTP
// status codes and bodies, plus the full TL-replacement flow end to end through the routes,
// against a fake repository (no database).

const DEPARTMENT = randomUUID();
const OTHER_DEPARTMENT = randomUUID();
const SELF = randomUUID();

function principalFor(role, overrides = {}) {
  return {
    userId: randomUUID(), employeeId: SELF, role, departmentId: DEPARTMENT,
    isTeamLead: role === "tl", ...overrides,
  };
}

function employee(overrides = {}) {
  return {
    id: randomUUID(), role: "employee", department_id: DEPARTMENT, team_lead_id: null,
    basic: 50000, allowances: 0, full_name: "Someone", email: "someone@example.com",
    position_title: "Engineer", joined_on: "2026-01-01",
    ...overrides,
  };
}

function fakeEmployeeRepository(seedEmployees = []) {
  const byId = new Map(seedEmployees.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async findTeamMembers(teamLeadId) {
      return seedEmployees.filter((row) => row.team_lead_id === teamLeadId && row.id !== teamLeadId);
    },
    async create(input) {
      calls.create.push(input);
      // Mirrors the real repository's return shape (snake_case DB columns via
      // selectEmployeeById), not the service's internal camelCase call shape -- a fake that
      // just echoed `input` back would silently hide a field-name mismatch like this one.
      return {
        id: randomUUID(),
        department_id: input.departmentId,
        team_lead_id: input.teamLeadId,
        full_name: input.fullName,
        phone: input.phone,
        position_title: input.positionTitle,
        joined_on: input.joinedOn,
        basic: input.basic,
        allowances: input.allowances,
        role: input.role,
        email: input.email,
      };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id, options) {
      calls.deleteById.push({ id, options });
    },
  };
}

async function startApp(principal, repository) {
  const employeeMutationService = createEmployeeMutationService({ employeeRepository: repository });
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: {},
    employeeMutationService,
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

const VALID_CREATE_BODY = Object.freeze({
  email: "new.hire@example.com", role: "employee", full_name: "New Hire",
  position_title: "Engineer", joined_on: "2026-09-25", basic: 50000, allowances: 0,
});

// ---------------------------------------------------------------------------
// POST /api/v1/employees -- representative role matrix + validation
// ---------------------------------------------------------------------------

test("POST /employees: admin creates any role and gets 201 with the created employee", async () => {
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository());
  try {
    const response = await app.request("POST", "/api/v1/employees", { ...VALID_CREATE_BODY, department_id: DEPARTMENT, role: "manager" });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.role, "manager");
  } finally {
    await app.close();
  }
});

test("POST /employees: employee may not create anyone -- 403", async () => {
  const app = await startApp(principalFor("employee"), fakeEmployeeRepository());
  try {
    const response = await app.request("POST", "/api/v1/employees", { ...VALID_CREATE_BODY, department_id: DEPARTMENT });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "employee_scope_denied");
  } finally {
    await app.close();
  }
});

test("POST /employees: a manager creating outside their own department is denied", async () => {
  const app = await startApp(principalFor("manager"), fakeEmployeeRepository());
  try {
    const response = await app.request("POST", "/api/v1/employees", { ...VALID_CREATE_BODY, department_id: OTHER_DEPARTMENT });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});

test("POST /employees: a manager omitting department_id gets it defaulted to their own", async () => {
  const app = await startApp(principalFor("manager"), fakeEmployeeRepository());
  try {
    const response = await app.request("POST", "/api/v1/employees", VALID_CREATE_BODY);
    assert.equal(response.status, 201);
    assert.equal(response.body.data.department_id, DEPARTMENT);
  } finally {
    await app.close();
  }
});

test("POST /employees: a strict-schema violation (an unexpected field) is rejected with 400, matching the old Firestore field denylist in spirit", async () => {
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository());
  try {
    const response = await app.request("POST", "/api/v1/employees", {
      ...VALID_CREATE_BODY, department_id: DEPARTMENT, password: "should-not-be-settable-here",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
  } finally {
    await app.close();
  }
});

test("POST /employees: a missing required field is rejected with 400", async () => {
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository());
  try {
    const { full_name, ...withoutFullName } = VALID_CREATE_BODY;
    void full_name;
    const response = await app.request("POST", "/api/v1/employees", { ...withoutFullName, department_id: DEPARTMENT });
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/employees/:id -- representative role matrix + validation
// ---------------------------------------------------------------------------

test("PATCH /employees/:id: hr updates a manager -- 200", async () => {
  const target = employee({ role: "manager" });
  const app = await startApp(principalFor("hr"), fakeEmployeeRepository([target]));
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${target.id}`, { phone: "0300-1234567" });
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: hr updating an admin is denied -- 403", async () => {
  const target = employee({ role: "admin" });
  const app = await startApp(principalFor("hr"), fakeEmployeeRepository([target]));
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${target.id}`, { phone: "0300-1234567" });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: nobody may change their own role, not even admin -- 403", async () => {
  const self = employee({ id: SELF, role: "admin" });
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository([self]));
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${SELF}`, { role: "hr" });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "self_role_change_denied");
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: a manager changing compensation is denied -- PAYROLL_ROLES only", async () => {
  const target = employee();
  const app = await startApp(principalFor("manager"), fakeEmployeeRepository([target]));
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${target.id}`, { basic: 999999 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "compensation_change_denied");
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: a well-formed but nonexistent id is a 404", async () => {
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository());
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${randomUUID()}`, { phone: "0300" });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: a malformed id is a 404, not a 400 -- matches the read path's convention", async () => {
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository());
  try {
    const response = await app.request("PATCH", "/api/v1/employees/not-a-uuid", { phone: "0300" });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test("PATCH /employees/:id: an empty body is rejected -- at least one field must be provided", async () => {
  const target = employee();
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository([target]));
  try {
    const response = await app.request("PATCH", `/api/v1/employees/${target.id}`, {});
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/employees/:id -- full role matrix (mirrors employeeAuthorization.test.js's
// DELETION_MATRIX exactly, run through the real HTTP stack)
// ---------------------------------------------------------------------------

const DELETION_MATRIX = [
  { actor: "admin", target: "manager", sameDept: true, ofMine: false, allowed: true },
  { actor: "admin", target: "employee", sameDept: false, ofMine: false, allowed: true },
  { actor: "hr", target: "manager", sameDept: true, ofMine: false, allowed: true },
  { actor: "hr", target: "admin", sameDept: true, ofMine: false, allowed: false },
  { actor: "manager", target: "employee", sameDept: true, ofMine: false, allowed: true },
  { actor: "manager", target: "tl", sameDept: true, ofMine: false, allowed: true },
  { actor: "manager", target: "employee", sameDept: false, ofMine: false, allowed: false },
  { actor: "manager", target: "manager", sameDept: true, ofMine: false, allowed: false },
  { actor: "tl", target: "employee", sameDept: true, ofMine: true, allowed: true },
  { actor: "tl", target: "employee", sameDept: true, ofMine: false, allowed: false },
  { actor: "tl", target: "tl", sameDept: true, ofMine: false, allowed: false },
  { actor: "employee", target: "employee", sameDept: true, ofMine: false, allowed: false },
];

test("DELETE /employees/:id: full role matrix, matching auth-matrix.md or a recorded decision", async () => {
  for (const row of DELETION_MATRIX) {
    const target = employee({
      role: row.target,
      department_id: row.sameDept ? DEPARTMENT : OTHER_DEPARTMENT,
      team_lead_id: row.ofMine ? SELF : randomUUID(),
    });
    const app = await startApp(principalFor(row.actor), fakeEmployeeRepository([target]));
    try {
      const response = await app.request("DELETE", `/api/v1/employees/${target.id}`);
      const label = `${row.actor} deleting ${row.target} (sameDept=${row.sameDept}, ofMine=${row.ofMine})`;
      if (row.allowed) {
        assert.equal(response.status, 204, label);
      } else {
        assert.equal(response.status, 403, label);
      }
    } finally {
      await app.close();
    }
  }
});

test("DELETE /employees/:id: nobody may delete themselves, not even admin -- 403", async () => {
  const self = employee({ id: SELF, role: "admin" });
  const app = await startApp(principalFor("admin"), fakeEmployeeRepository([self]));
  try {
    const response = await app.request("DELETE", `/api/v1/employees/${SELF}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "self_delete_denied");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// DELETE: the full TL-replacement flow and its failure cases, end to end
// ---------------------------------------------------------------------------

test("DELETE a tl with members and no replacement supplied: 400, deleteById never called", async () => {
  const tl = employee({ role: "tl" });
  const member = employee({ team_lead_id: tl.id });
  const repository = fakeEmployeeRepository([tl, member]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/employees/${tl.id}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "team_lead_replacement_required");
    assert.equal(repository.calls.deleteById.length, 0);
  } finally {
    await app.close();
  }
});

test("DELETE a tl with a replacement not drawn from their own members: 403, deleteById never called", async () => {
  const tl = employee({ role: "tl" });
  const member = employee({ team_lead_id: tl.id });
  const outsider = employee();
  const repository = fakeEmployeeRepository([tl, member, outsider]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/employees/${tl.id}`, {
      replacement_team_lead_id: outsider.id,
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "team_lead_replacement_invalid");
    assert.equal(repository.calls.deleteById.length, 0);
  } finally {
    await app.close();
  }
});

test("DELETE a tl with a valid replacement: 204, and the repository receives the exact reassignment", async () => {
  const tl = employee({ role: "tl" });
  const memberA = employee({ team_lead_id: tl.id });
  const memberB = employee({ team_lead_id: tl.id });
  const repository = fakeEmployeeRepository([tl, memberA, memberB]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/employees/${tl.id}`, {
      replacement_team_lead_id: memberA.id,
    });
    assert.equal(response.status, 204);
    assert.deepEqual(repository.calls.deleteById[0], {
      id: tl.id,
      options: { replacementTeamLeadId: memberA.id, reassignedMemberIds: [memberB.id] },
    });
  } finally {
    await app.close();
  }
});

test("decision D16, end to end: deleting a tl with zero members succeeds outright, no replacement needed", async () => {
  const tl = employee({ role: "tl" });
  const repository = fakeEmployeeRepository([tl]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/employees/${tl.id}`);
    assert.equal(response.status, 204);
    assert.deepEqual(repository.calls.deleteById[0].options, { replacementTeamLeadId: null, reassignedMemberIds: [] });
  } finally {
    await app.close();
  }
});
