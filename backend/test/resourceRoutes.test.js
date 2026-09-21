import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";

// Real HTTP requests against createServer(app), matching authenticationBoundary.test.js's
// pattern. Every test injects `repositories` explicitly -- never omitted -- so a route
// handler can never fall through to getContainer() and attempt a real database
// connection. Scope-predicate correctness is covered at the repository level
// (resourceRepositories.test.js); these tests prove the seven domains are actually
// mounted, wired to the right repository, and produce the right HTTP status/envelope.

const PRINCIPAL = Object.freeze({
  userId: "user-1",
  employeeId: "emp-1",
  role: "manager",
  departmentId: "dept-1",
  isTeamLead: false,
});

const DOMAINS = [
  { path: "/api/v1/employees", key: "employeeRepository", resourceName: "employee" },
  { path: "/api/v1/departments", key: "departmentRepository", resourceName: "department" },
  { path: "/api/v1/projects", key: "projectRepository", resourceName: "project" },
  { path: "/api/v1/kpis", key: "kpiRepository", resourceName: "kpi" },
  { path: "/api/v1/leaves", key: "leaveRepository", resourceName: "leave" },
  { path: "/api/v1/attendance", key: "attendanceRepository", resourceName: "attendance record" },
  { path: "/api/v1/payroll", key: "payrollRepository", resourceName: "payroll record" },
];

function fakeRepository({ listResult = [], detailResult = null, throwOnList = null } = {}) {
  const calls = [];
  return {
    calls,
    async listForPrincipal(principal) {
      calls.push({ method: "list", principal });
      if (throwOnList) throw throwOnList;
      return listResult;
    },
    async findByIdForPrincipal(id, principal) {
      calls.push({ method: "getById", id, principal });
      return detailResult;
    },
  };
}

/** Starts the app with the given repositories injected; no domain falls through to a real database. */
async function startApp(repositories, verifyAccessToken = async () => PRINCIPAL) {
  const app = createApp({ verifyAccessToken, repositories });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async get(pathname, headers = { authorization: "Bearer x" }) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** All seven repositories stubbed empty, so any domain not under test still answers cleanly. */
function allEmptyRepositories(overrides = {}) {
  const repositories = {};
  for (const { key } of DOMAINS) repositories[key] = fakeRepository();
  return { ...repositories, ...overrides };
}

test("every domain 401s with no bearer token", async () => {
  const app = await startApp(allEmptyRepositories());
  try {
    for (const { path } of DOMAINS) {
      const response = await app.get(path, {});
      assert.equal(response.status, 401, path);
    }
  } finally {
    await app.close();
  }
});

test("every domain's list route calls listForPrincipal on its own repository and returns { data: [...] }", async () => {
  for (const { path, key } of DOMAINS) {
    const marker = { id: randomUUID(), _marker: key };
    const repositories = allEmptyRepositories({ [key]: fakeRepository({ listResult: [marker] }) });
    const app = await startApp(repositories);
    try {
      const response = await app.get(path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.body, { data: [marker] }, path);
      assert.equal(repositories[key].calls.length, 1);
      assert.equal(repositories[key].calls[0].method, "list");
      assert.deepEqual(repositories[key].calls[0].principal, PRINCIPAL);
    } finally {
      await app.close();
    }
  }
});

test("every domain's detail route returns { data } for a hit and 404 for a miss", async () => {
  const id = randomUUID();
  for (const { path, key, resourceName } of DOMAINS) {
    const hitRepositories = allEmptyRepositories({ [key]: fakeRepository({ detailResult: { id } }) });
    const hitApp = await startApp(hitRepositories);
    try {
      const hit = await hitApp.get(`${path}/${id}`);
      assert.equal(hit.status, 200, path);
      assert.deepEqual(hit.body, { data: { id } }, path);
    } finally {
      await hitApp.close();
    }

    const missRepositories = allEmptyRepositories({ [key]: fakeRepository({ detailResult: null }) });
    const missApp = await startApp(missRepositories);
    try {
      const miss = await missApp.get(`${path}/${randomUUID()}`);
      assert.equal(miss.status, 404, path);
      assert.equal(miss.body.error.code, "not_found");
      assert.match(miss.body.error.message, new RegExp(resourceName));
    } finally {
      await missApp.close();
    }
  }
});

test("every domain's detail route 404s on a malformed id without calling the repository", async () => {
  for (const { path, key } of DOMAINS) {
    const repositories = allEmptyRepositories({ [key]: fakeRepository({ detailResult: { id: "should-not-be-returned" } }) });
    const app = await startApp(repositories);
    try {
      const response = await app.get(`${path}/not-a-uuid`);
      assert.equal(response.status, 404, path);
      assert.equal(repositories[key].calls.length, 0, `${path}: malformed id must not reach the repository`);
    } finally {
      await app.close();
    }
  }
});

test("a repository error is handled by the shared error handler, not leaked as an unhandled rejection", async () => {
  const repositories = allEmptyRepositories({
    employeeRepository: fakeRepository({ throwOnList: new Error("connection reset") }),
  });
  const app = await startApp(repositories);
  try {
    const response = await app.get("/api/v1/employees");
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "internal");
    assert.doesNotMatch(JSON.stringify(response.body), /connection reset/);
  } finally {
    await app.close();
  }
});

test("health remains public alongside the seven mounted domains", async () => {
  const app = await startApp(allEmptyRepositories());
  try {
    const response = await app.get("/api/v1/health", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  } finally {
    await app.close();
  }
});
