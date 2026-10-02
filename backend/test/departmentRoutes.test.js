import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createDepartmentMutationService } from "../src/services/departmentMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The exhaustive authorization matrix lives in departmentAuthorization.test.js
// (pure, fast, no server); these tests prove the real departmentMutationService +
// departmentAuthorizationService are correctly wired to real HTTP status codes and bodies,
// against a fake repository (no database).

function principalFor(role, overrides = {}) {
  return { userId: randomUUID(), employeeId: randomUUID(), role, departmentId: randomUUID(), isTeamLead: role === "tl", ...overrides };
}

function department(overrides = {}) {
  return { id: randomUUID(), name: "Engineering", description: null, status: "active", manager_employee_id: null, ...overrides };
}

/**
 * deleteById throws the same 404/409 HttpErrors the real repository would -- seeded via
 * employeeCountByDepartment -- so the controller/service wiring is exercised exactly as it
 * would be for real, not a looser approximation of it.
 */
function fakeDepartmentRepository(seedDepartments = [], { employeeCountByDepartment = {} } = {}) {
  const byId = new Map(seedDepartments.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async create(input) {
      calls.create.push(input);
      return { id: randomUUID(), manager_employee_id: null, ...input };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      if (!byId.has(id)) return null;
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id) {
      calls.deleteById.push(id);
      if (!byId.has(id)) throw new HttpError(404, "not_found", "Department not found.");
      const count = employeeCountByDepartment[id] ?? 0;
      if (count > 0) {
        throw new HttpError(
          409,
          "department_has_employees",
          `This department still has ${count} employee(s); move them to another department before deleting it.`,
        );
      }
    },
  };
}

async function startApp(principal, repository) {
  const departmentMutationService = createDepartmentMutationService({ departmentRepository: repository });
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: {},
    departmentMutationService,
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

const VALID_CREATE_BODY = Object.freeze({ name: "Engineering" });

// ---------------------------------------------------------------------------
// Role matrices: every role against each of the three operations
// ---------------------------------------------------------------------------

test("POST /departments: admin only", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository();
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("POST", "/api/v1/departments", VALID_CREATE_BODY);
      if (role === "admin") {
        assert.equal(response.status, 201, role);
        assert.equal(repository.calls.create.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.create.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

test("PATCH /departments/:id: admin only", async () => {
  const target = department();
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/departments/${target.id}`, { name: "Platform" });
      if (role === "admin") {
        assert.equal(response.status, 200, role);
        assert.equal(repository.calls.updateById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(repository.calls.updateById.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

test("DELETE /departments/:id: admin only", async () => {
  const target = department();
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("DELETE", `/api/v1/departments/${target.id}`);
      if (role === "admin") {
        assert.equal(response.status, 204, role);
        assert.equal(repository.calls.deleteById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(repository.calls.deleteById.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Schema enforcement
// ---------------------------------------------------------------------------

test("POST /departments: manager_employee_id is rejected outright, not silently ignored", async () => {
  const repository = fakeDepartmentRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/departments", {
      ...VALID_CREATE_BODY, manager_employee_id: randomUUID(),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
    assert.equal(repository.calls.create.length, 0);
  } finally {
    await app.close();
  }
});

test("status schema refuses 'invited' and 'suspended' -- account_status allows them, departments must not", async () => {
  const target = department();
  for (const status of ["invited", "suspended"]) {
    const createRepository = fakeDepartmentRepository();
    const createApp_ = await startApp(principalFor("admin"), createRepository);
    try {
      const createResponse = await createApp_.request("POST", "/api/v1/departments", { name: "Engineering", status });
      assert.equal(createResponse.status, 400, `create with status=${status}`);
    } finally {
      await createApp_.close();
    }

    const updateRepository = fakeDepartmentRepository([target]);
    const updateApp = await startApp(principalFor("admin"), updateRepository);
    try {
      const updateResponse = await updateApp.request("PATCH", `/api/v1/departments/${target.id}`, { status });
      assert.equal(updateResponse.status, 400, `update with status=${status}`);
    } finally {
      await updateApp.close();
    }
  }
});

test("PATCH /departments/:id: an empty body is rejected -- at least one field must be provided", async () => {
  const target = department();
  const repository = fakeDepartmentRepository([target]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/departments/${target.id}`, {});
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D15: clearing a manager auto-nulls, no forced reassignment
// ---------------------------------------------------------------------------

test("PATCH /departments/:id: setting manager_employee_id to null alone succeeds -- D15, no replacement required", async () => {
  const target = department({ manager_employee_id: randomUUID() });
  const repository = fakeDepartmentRepository([target]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/departments/${target.id}`, { manager_employee_id: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.manager_employee_id, null);
    assert.deepEqual(repository.calls.updateById[0].changes, { manager_employee_id: null });
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D26: deleting a department with live employees
// ---------------------------------------------------------------------------

test("DELETE /departments/:id: D26 -- live employees refuse with 409 and the count in the message", async () => {
  const target = department();
  const repository = fakeDepartmentRepository([target], { employeeCountByDepartment: { [target.id]: 5 } });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/departments/${target.id}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "department_has_employees");
    assert.match(response.body.error.message, /\b5\b/);
  } finally {
    await app.close();
  }
});

test("DELETE /departments/:id: zero employees succeeds", async () => {
  const target = department();
  const repository = fakeDepartmentRepository([target], { employeeCountByDepartment: { [target.id]: 0 } });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/departments/${target.id}`);
    assert.equal(response.status, 204);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// id handling
// ---------------------------------------------------------------------------

test("PATCH and DELETE: a malformed id is a 404, matching the read path's convention", async () => {
  const repository = fakeDepartmentRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const patchResponse = await app.request("PATCH", "/api/v1/departments/not-a-uuid", { name: "Platform" });
    assert.equal(patchResponse.status, 404);

    const deleteResponse = await app.request("DELETE", "/api/v1/departments/not-a-uuid");
    assert.equal(deleteResponse.status, 404);
  } finally {
    await app.close();
  }
});

test("PATCH: a well-formed but nonexistent id is a 404", async () => {
  const repository = fakeDepartmentRepository([]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/departments/${randomUUID()}`, { name: "Platform" });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});
