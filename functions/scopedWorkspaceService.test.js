/* global require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ScopedWorkspaceServiceError,
  createScopedWorkspaceService,
} = require("./scopedWorkspaceService");

const CALLER_UID = "caller-auth-uid";
const PRINCIPAL_ID = "principal-document";
const TIMESTAMP = "2026-08-22T10:00:00.000Z";

function authLink(overrides = {}) {
  return {
    employeeId: PRINCIPAL_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    uid: CALLER_UID,
    status: "active",
    role: "manager",
    dept: "Engineering",
    email: "must-not-return@example.com",
    salary: 999999,
    token: "principal-secret-token",
    ...overrides,
  };
}

function project(id, overrides = {}) {
  return {
    id,
    data: {
      title: `Project ${id}`,
      name: `Legacy ${id}`,
      description: "Project description",
      department: "Engineering",
      teamLeadId: "team-lead-1",
      assignedEmployeeIds: ["employee-1"],
      startDate: "2026-08-01",
      dueDate: "2026-09-01",
      status: "active",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      salaryBudget: 500000,
      credentials: "project-secret",
      ...overrides,
    },
  };
}

function kpi(id, overrides = {}) {
  return {
    id,
    data: {
      projectId: "project-1",
      empId: "employee-1",
      title: `KPI ${id}`,
      target: 100,
      current: 50,
      weight: 20,
      period: "Q3 2026",
      status: "active",
      rating: 8,
      ratedBy: "reviewer-id",
      ratedAt: TIMESTAMP,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      employeeProfile: { salary: 999999 },
      token: "kpi-secret-token",
      ...overrides,
    },
  };
}

function employee(id, overrides = {}) {
  return {
    id,
    data: {
      dept: "Engineering",
      teamLeadId: null,
      name: `Employee ${id}`,
      salary: 200000,
      ...overrides,
    },
  };
}

function matches(record, field, operator, value) {
  const fieldValue = record.data[field];
  if (operator === "==") return fieldValue === value;
  if (operator === "in") return value.some((candidate) => Object.is(candidate, fieldValue));
  if (operator === "array-contains-any") {
    return Array.isArray(fieldValue)
      && fieldValue.some((item) => value.some((candidate) => Object.is(candidate, item)));
  }
  throw new Error(`unsupported test operator: ${operator}`);
}

function createHarness(options = {}) {
  const calls = {
    collections: [],
    documentReads: [],
    queries: [],
    unrestrictedReads: 0,
    logs: [],
  };
  const state = {
    authLinks: new Map(),
    employees: new Map(),
    projects: new Map(),
    kpis: new Map(),
  };

  if (options.authLink !== null) {
    state.authLinks.set(CALLER_UID, options.authLink || authLink());
  }
  if (options.principal !== null) {
    state.employees.set(
      options.principalId || PRINCIPAL_ID,
      options.principal || principal(),
    );
  }
  for (const record of options.employees || []) state.employees.set(record.id, record.data);
  for (const record of options.projects || []) state.projects.set(record.id, record.data);
  for (const record of options.kpis || []) state.kpis.set(record.id, record.data);

  function queryFor(collectionName, field, operator, value) {
    const queryCall = {
      collection: collectionName,
      field,
      operator,
      value: Array.isArray(value) ? [...value] : value,
      selectedFields: [],
    };
    calls.queries.push(queryCall);
    return {
      select(...fields) {
        queryCall.selectedFields = [...fields];
        return this;
      },
      async get() {
        if (options.queryError) throw options.queryError;
        const documents = [...state[collectionName].entries()]
          .filter(([id, data]) => matches({ id, data }, field, operator, value))
          .map(([id, data]) => ({ id, data: () => ({ ...data }) }));
        return {
          docs: options.duplicateQueryDocuments
            ? documents.flatMap((document) => [document, document])
            : documents,
        };
      },
    };
  }

  const firestore = {
    collection(name) {
      calls.collections.push(name);
      if (!Object.prototype.hasOwnProperty.call(state, name)) {
        throw new Error("unexpected collection");
      }
      return {
        doc(id) {
          return {
            async get() {
              calls.documentReads.push({ collection: name, id });
              if (options.documentReadError) throw options.documentReadError;
              const exists = state[name].has(id);
              return {
                exists,
                data: () => state[name].get(id),
              };
            },
          };
        },
        where(field, operator, value) {
          return queryFor(name, field, operator, value);
        },
        async get() {
          calls.unrestrictedReads += 1;
          throw new Error("unrestricted reads are forbidden");
        },
      };
    },
  };
  const logger = {
    error(...parts) {
      calls.logs.push(parts);
      if (options.loggerError) throw options.loggerError;
    },
  };
  const service = createScopedWorkspaceService({ firestore, logger });
  return { service, calls, state };
}

async function expectServiceError(promise, code, reason) {
  let received;
  try {
    await promise;
  } catch (error) {
    received = error;
  }
  assert.ok(received instanceof ScopedWorkspaceServiceError);
  assert.equal(received.name, "ScopedWorkspaceServiceError");
  assert.equal(received.code, code);
  assert.equal(received.reason, reason);
  assert.equal(typeof received.message, "string");
  assert.ok(received.message.length > 0);
  return received;
}

function assertNoUnrestrictedRead(calls) {
  assert.equal(calls.unrestrictedReads, 0);
  for (const queryCall of calls.queries) {
    assert.equal(typeof queryCall.field, "string");
    assert.ok(queryCall.field.length > 0);
    assert.ok(["==", "in", "array-contains-any"].includes(queryCall.operator));
    if (["in", "array-contains-any"].includes(queryCall.operator)) {
      assert.ok(queryCall.value.length >= 1);
      assert.ok(queryCall.value.length <= 30);
    }
  }
}

test("Manager receives only department projects, related KPIs, and department legacy KPIs", async () => {
  const { service, calls } = createHarness({
    employees: [
      employee("employee-1"),
      employee("employee-2"),
      employee("employee-other", { dept: "Finance" }),
    ],
    projects: [
      project("project-1"),
      project("project-2"),
      project("project-other", { department: "Finance" }),
    ],
    kpis: [
      kpi("project-kpi", { projectId: "project-1", empId: "employee-other" }),
      kpi("other-project-kpi", { projectId: "project-other", empId: "employee-1" }),
      kpi("legacy-kpi", { projectId: undefined, empId: "employee-1" }),
      kpi("blank-legacy-kpi", { projectId: "", empId: "employee-2" }),
      kpi("other-legacy-kpi", { projectId: null, empId: "employee-other" }),
    ],
  });

  const result = await service.getScopedWorkspace(CALLER_UID);

  assert.deepEqual(result.projects.map(({ id }) => id), ["project-1", "project-2"]);
  assert.deepEqual(result.kpis.map(({ id }) => id), [
    "blank-legacy-kpi",
    "legacy-kpi",
    "project-kpi",
  ]);
  assert.ok(calls.queries.some((queryCall) =>
    queryCall.collection === "projects"
    && queryCall.field === "department"
    && queryCall.operator === "=="
    && queryCall.value === "Engineering"));
  assertNoUnrestrictedRead(calls);
});

test("Team Lead receives direct and team-member projects with scoped project and legacy KPIs", async () => {
  const { service, calls } = createHarness({
    principal: principal({ role: "tl", dept: "Engineering" }),
    employees: [
      employee("member-1", { teamLeadId: PRINCIPAL_ID }),
      employee("member-2", { teamLeadId: PRINCIPAL_ID }),
      employee("other-member", { teamLeadId: "other-team-lead" }),
    ],
    projects: [
      project("direct-project", {
        teamLeadId: PRINCIPAL_ID,
        assignedEmployeeIds: [],
      }),
      project("member-project", {
        teamLeadId: "other-team-lead",
        assignedEmployeeIds: ["member-1"],
      }),
      project("both-project", {
        teamLeadId: PRINCIPAL_ID,
        assignedEmployeeIds: ["member-2"],
      }),
      project("cross-team-project", {
        teamLeadId: "other-team-lead",
        assignedEmployeeIds: ["other-member"],
      }),
    ],
    kpis: [
      kpi("direct-kpi", { projectId: "direct-project", empId: "other-member" }),
      kpi("member-kpi", { projectId: "member-project", empId: "member-1" }),
      kpi("cross-team-kpi", { projectId: "cross-team-project", empId: "member-1" }),
      kpi("self-legacy", { projectId: undefined, empId: PRINCIPAL_ID }),
      kpi("member-legacy", { projectId: null, empId: "member-2" }),
      kpi("other-legacy", { projectId: undefined, empId: "other-member" }),
    ],
  });

  const result = await service.getScopedWorkspace(CALLER_UID);

  assert.deepEqual(result.projects.map(({ id }) => id), [
    "both-project",
    "direct-project",
    "member-project",
  ]);
  assert.deepEqual(result.kpis.map(({ id }) => id), [
    "direct-kpi",
    "member-kpi",
    "member-legacy",
    "self-legacy",
  ]);
  assert.ok(calls.queries.some((queryCall) =>
    queryCall.collection === "projects"
    && queryCall.operator === "array-contains-any"));
  assertNoUnrestrictedRead(calls);
});

test("supports safe numeric and string legacy relationship variants", async () => {
  const { service, calls } = createHarness({
    principalId: "7",
    authLink: authLink({ employeeId: "7" }),
    principal: principal({ role: "tl" }),
    employees: [employee("8", { teamLeadId: 7 })],
    projects: [
      project("9", { teamLeadId: 7, assignedEmployeeIds: [] }),
      project("10", { teamLeadId: "other", assignedEmployeeIds: [8] }),
    ],
    kpis: [
      kpi("numeric-project-kpi", { projectId: 9, empId: 8 }),
      kpi("numeric-member-project-kpi", { projectId: 10, empId: 8 }),
      kpi("numeric-self-legacy", { projectId: undefined, empId: 7 }),
    ],
  });

  const result = await service.getScopedWorkspace(CALLER_UID);

  assert.deepEqual(result.projects.map(({ id }) => id), ["10", "9"]);
  assert.deepEqual(result.kpis.map(({ id }) => id), [
    "numeric-member-project-kpi",
    "numeric-project-kpi",
    "numeric-self-legacy",
  ]);
  const queryValues = calls.queries
    .filter(({ operator }) => operator === "in" || operator === "array-contains-any")
    .flatMap(({ value }) => value);
  assert.ok(queryValues.includes("7"));
  assert.ok(queryValues.includes(7));
  assert.ok(queryValues.includes("8"));
  assert.ok(queryValues.includes(8));
});

test("returns empty arrays without unrestricted fallback for empty authorized scopes", async (t) => {
  await t.test("Manager", async () => {
    const { service, calls } = createHarness();
    const result = await service.getScopedWorkspace(CALLER_UID);
    assert.deepEqual(result, { projects: [], kpis: [] });
    assertNoUnrestrictedRead(calls);
  });

  await t.test("Team Lead", async () => {
    const { service, calls } = createHarness({
      principal: principal({ role: "tl" }),
    });
    const result = await service.getScopedWorkspace(CALLER_UID);
    assert.deepEqual(result, { projects: [], kpis: [] });
    assertNoUnrestrictedRead(calls);
  });
});

test("chunks Manager project and legacy employee KPI queries at 30 values", async () => {
  const projects = Array.from({ length: 31 }, (_, index) => project(`project-${index}`));
  const employees = Array.from({ length: 30 }, (_, index) => employee(`employee-${index}`));
  const { service, calls } = createHarness({ projects, employees });

  await service.getScopedWorkspace(CALLER_UID);

  const projectKpiQueries = calls.queries.filter((queryCall) =>
    queryCall.collection === "kpis" && queryCall.field === "projectId");
  const legacyKpiQueries = calls.queries.filter((queryCall) =>
    queryCall.collection === "kpis" && queryCall.field === "empId");
  assert.deepEqual(projectKpiQueries.map(({ value }) => value.length), [30, 1]);
  assert.deepEqual(legacyKpiQueries.map(({ value }) => value.length), [30, 1]);
  assertNoUnrestrictedRead(calls);
});

test("chunks Team Lead array-contains-any project queries at 30 values", async () => {
  const employees = Array.from({ length: 31 }, (_, index) =>
    employee(`member-${index}`, { teamLeadId: PRINCIPAL_ID }));
  const { service, calls } = createHarness({
    principal: principal({ role: "tl" }),
    employees,
  });

  await service.getScopedWorkspace(CALLER_UID);

  const assignedProjectQueries = calls.queries.filter((queryCall) =>
    queryCall.collection === "projects"
    && queryCall.field === "assignedEmployeeIds");
  assert.deepEqual(assignedProjectQueries.map(({ value }) => value.length), [30, 1]);
  assertNoUnrestrictedRead(calls);
});

test("deduplicates documents returned through overlapping sources", async () => {
  const { service } = createHarness({
    principal: principal({ role: "tl" }),
    employees: [employee("member-1", { teamLeadId: PRINCIPAL_ID })],
    projects: [project("overlap", {
      teamLeadId: PRINCIPAL_ID,
      assignedEmployeeIds: ["member-1"],
    })],
    kpis: [kpi("one-kpi", { projectId: "overlap" })],
    duplicateQueryDocuments: true,
  });

  const result = await service.getScopedWorkspace(CALLER_UID);

  assert.deepEqual(result.projects.map(({ id }) => id), ["overlap"]);
  assert.deepEqual(result.kpis.map(({ id }) => id), ["one-kpi"]);
});

test("returns only exact UI-required Project and KPI fields", async () => {
  const { service } = createHarness({
    employees: [employee("employee-1")],
    projects: [project("project-1")],
    kpis: [kpi("kpi-1")],
  });

  const result = await service.getScopedWorkspace(CALLER_UID);
  const returnedProject = result.projects[0];
  const returnedKpi = result.kpis[0];

  assert.deepEqual(Object.keys(returnedProject), [
    "id",
    "title",
    "name",
    "description",
    "department",
    "startDate",
    "dueDate",
    "status",
    "createdAt",
    "updatedAt",
    "teamLeadId",
    "assignedEmployeeIds",
  ]);
  assert.deepEqual(Object.keys(returnedKpi), [
    "id",
    "title",
    "period",
    "status",
    "ratedAt",
    "createdAt",
    "updatedAt",
    "projectId",
    "empId",
    "ratedBy",
    "target",
    "current",
    "weight",
    "rating",
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "salaryBudget",
    "credentials",
    "employeeProfile",
    "must-not-return@example.com",
    "principal-secret-token",
    "project-secret",
    "kpi-secret-token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(result), ["projects", "kpis"]);
});

test("rejects invalid, missing, inactive, conflicting, and unauthorized principals", async (t) => {
  const cases = [
    {
      name: "invalid identity",
      harness: {},
      uid: "uid with spaces",
      code: "unauthenticated",
      reason: "INVALID_AUTH_IDENTITY",
      expectedReads: 0,
    },
    {
      name: "missing auth link",
      harness: { authLink: null },
      code: "not-found",
      reason: "AUTH_LINK_MISSING",
    },
    {
      name: "conflicting auth link",
      harness: { authLink: { ...authLink(), unexpected: true } },
      code: "failed-precondition",
      reason: "AUTH_LINK_CONFLICT",
    },
    {
      name: "missing employee",
      harness: { principal: null },
      code: "not-found",
      reason: "EMPLOYEE_NOT_FOUND",
    },
    {
      name: "UID mismatch",
      harness: { principal: principal({ uid: "different-uid" }) },
      code: "failed-precondition",
      reason: "EMPLOYEE_UID_MISMATCH",
    },
    {
      name: "inactive principal",
      harness: { principal: principal({ status: "inactive" }) },
      code: "failed-precondition",
      reason: "EMPLOYEE_INACTIVE",
    },
    {
      name: "unauthorized role",
      harness: { principal: principal({ role: "employee" }) },
      code: "permission-denied",
      reason: "ROLE_NOT_ALLOWED",
    },
    {
      name: "missing Manager department",
      harness: { principal: principal({ dept: "" }) },
      code: "failed-precondition",
      reason: "PRINCIPAL_SCOPE_INVALID",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { service, calls } = createHarness(scenario.harness);
      await expectServiceError(
        service.getScopedWorkspace(scenario.uid || CALLER_UID),
        scenario.code,
        scenario.reason,
      );
      if (scenario.expectedReads === 0) assert.equal(calls.documentReads.length, 0);
      assertNoUnrestrictedRead(calls);
    });
  }
});

test("maps query failures to a typed safe error with identity-free logging", async () => {
  const { service, calls } = createHarness({ queryError: new Error("raw database detail") });

  const error = await expectServiceError(
    service.getScopedWorkspace(CALLER_UID),
    "internal",
    "SCOPED_QUERY_FAILED",
  );

  assert.equal(error.message.includes("raw database detail"), false);
  assert.equal(calls.logs.length, 1);
  const serializedLog = JSON.stringify(calls.logs);
  assert.equal(serializedLog.includes(CALLER_UID), false);
  assert.equal(serializedLog.includes("Engineering"), false);
  assert.equal(serializedLog.includes("raw database detail"), false);
});

test("rejects invalid dependency configuration", () => {
  assert.throws(
    () => createScopedWorkspaceService({ firestore: null, logger: { error() {} } }),
    (error) => error instanceof ScopedWorkspaceServiceError
      && error.reason === "INVALID_SERVICE_CONFIGURATION",
  );
  assert.throws(
    () => createScopedWorkspaceService({ firestore: { collection() {} }, logger: null }),
    (error) => error instanceof ScopedWorkspaceServiceError
      && error.reason === "INVALID_SERVICE_CONFIGURATION",
  );
});
