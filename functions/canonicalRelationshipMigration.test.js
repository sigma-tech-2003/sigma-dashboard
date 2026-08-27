/* global require */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COLLECTIONS,
  createCanonicalRelationshipMigration,
  planCanonicalRelationships,
  summarizePlan,
} = require("./canonicalRelationshipMigration");
const {
  createAdminMigrationRepository,
  parseCliArguments,
  runCli,
} = require("./scripts/migrateCanonicalRelationships");

const NOW = "2026-08-22T10:00:00.000Z";

function document(id, data, version = `version:${id}`) {
  return { id, data, version };
}

function baseDataset() {
  return {
    employees: [
      document("employee-a", { id: 1, role: "tl", dept: "Engineering", status: "active" }),
      document("employee-b", {
        id: 2,
        role: "employee",
        dept: "Engineering",
        status: "active",
        teamLeadId: "employee-a",
      }),
    ],
    departments: [document("100", {
      id: 100,
      name: "Engineering",
      status: "Active",
      createdAt: NOW,
      managerId: "employee-a",
    })],
    projects: [document("project-a", {
      id: 10,
      title: "Canonical project",
      department: "Engineering",
      teamLeadId: "employee-a",
      assignedEmployeeIds: ["employee-b"],
    })],
    kpis: [document("kpi-a", {
      id: 20,
      projectId: "project-a",
      empId: "employee-b",
      ratedBy: "employee-a",
      title: "Quality",
    })],
    leaves: [document("leave-a", { id: 30, empId: "employee-b", status: "pending" })],
    attendance: [document("attendance-a", { empId: "employee-b", status: "present" })],
    payroll: [document("payroll-a", { id: 40, empId: "employee-b", status: "processed" })],
    leaveBalances: [document("employee-b", { Annual: { t: 15, u: 2, r: 13 } })],
    authLinks: [],
  };
}

function actionFor(plan, collection, id = null) {
  return plan.actions.find((action) =>
    action.collection === collection
    && (id === null || action.id === id || action.sourceId === id));
}

function conflictCategories(plan) {
  return new Set(plan.conflicts.map((conflict) => conflict.category));
}

function mockRepository(dataset, applyChunk = async (actions) => ({
  writes: actions.reduce((total, action) => total + action.writeCount, 0),
})) {
  return {
    loadCollections: async (names) => Object.fromEntries(names.map((name) => [name, dataset[name]])),
    applyChunk,
  };
}

test("canonical records are deterministic no-ops", () => {
  const plan = planCanonicalRelationships(baseDataset());
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.actions.length, 0);
  assert.equal(summarizePlan(plan).totals.writes, 0);
  assert.equal(plan.stats.projects.noOps, 1);
  assert.equal(plan.stats.leaveBalances.noOps, 1);
});

test("numeric and string legacy relationships migrate across every proven collection", () => {
  const dataset = baseDataset();
  dataset.employees[1].data.teamLeadId = 1;
  dataset.departments[0].data.managerId = "1";
  dataset.projects[0].data.teamLeadId = 1;
  dataset.projects[0].data.assignedEmployeeIds = [2, "2", "employee-b"];
  dataset.kpis[0].data = {
    ...dataset.kpis[0].data,
    empId: 2,
    projectId: "10",
    ratedBy: 1,
  };
  dataset.leaves[0].data.empId = 2;
  dataset.attendance[0].data.empId = "2";
  dataset.payroll[0].data.empId = 2;
  dataset.leaveBalances = [document("2", { Annual: { t: 15, u: 2, r: 13 } })];

  const plan = planCanonicalRelationships(dataset);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(actionFor(plan, "employees").changes, { teamLeadId: "employee-a" });
  assert.deepEqual(actionFor(plan, "departments").changes, { managerId: "employee-a" });
  assert.deepEqual(actionFor(plan, "projects").changes, {
    teamLeadId: "employee-a",
    assignedEmployeeIds: ["employee-b"],
  });
  assert.deepEqual(actionFor(plan, "kpis").changes, {
    empId: "employee-b",
    projectId: "project-a",
    ratedBy: "employee-a",
  });
  for (const collection of ["leaves", "attendance", "payroll"]) {
    assert.deepEqual(actionFor(plan, collection).changes, { empId: "employee-b" });
  }
  const relocation = actionFor(plan, "leaveBalances", "2");
  assert.equal(relocation.destinationId, "employee-b");
  assert.equal(relocation.mode, "move");
  assert.equal(relocation.writeCount, 2);
});

test("assignment normalization preserves meaningful order while deduplicating", () => {
  const dataset = baseDataset();
  dataset.employees.push(document("employee-c", { id: 3, role: "employee" }));
  dataset.projects[0].data.assignedEmployeeIds = [3, 2, "3", "employee-b", "employee-c"];
  const plan = planCanonicalRelationships(dataset);
  assert.deepEqual(actionFor(plan, "projects").changes.assignedEmployeeIds, [
    "employee-c",
    "employee-b",
  ]);
});

test("display identifiers and unrelated fields are never rewritten", () => {
  const dataset = baseDataset();
  dataset.employees[1].data.teamLeadId = 1;
  dataset.employees[1].data.empId = "EMP-DISPLAY";
  dataset.employees[1].data.unrelatedText = "preserved";
  dataset.employees[1].data.unrelatedNumber = 999;
  const plan = planCanonicalRelationships(dataset);
  const action = actionFor(plan, "employees", "employee-b");
  assert.deepEqual(Object.keys(action.changes), ["teamLeadId"]);
  assert.equal(dataset.employees[1].data.empId, "EMP-DISPLAY");
  assert.equal(dataset.employees[1].data.unrelatedText, "preserved");
  assert.equal(dataset.employees[1].data.unrelatedNumber, 999);
});

test("ambiguous employee aliases and cross-links are conflicts, never guesses", () => {
  const dataset = baseDataset();
  dataset.employees.push(document("2", { id: 99, role: "employee" }));
  dataset.leaves[0].data.empId = 2;
  const plan = planCanonicalRelationships(dataset);
  const categories = conflictCategories(plan);
  assert(categories.has("ambiguous-employee-alias"));
  assert(categories.has("ambiguous-employee-reference"));
  assert.equal(actionFor(plan, "leaves"), undefined);
});

test("ambiguous Project aliases block KPI Project migration", () => {
  const dataset = baseDataset();
  dataset.projects.push(document("10", {
    id: 11,
    assignedEmployeeIds: ["employee-b"],
  }));
  dataset.kpis[0].data.projectId = 10;
  const plan = planCanonicalRelationships(dataset);
  const categories = conflictCategories(plan);
  assert(categories.has("ambiguous-project-alias"));
  assert(categories.has("ambiguous-project-reference"));
  assert.equal(actionFor(plan, "kpis"), undefined);
});

test("missing and malformed scalar references are reported without partial patches", () => {
  const dataset = baseDataset();
  dataset.kpis[0].data.empId = "missing";
  dataset.kpis[0].data.projectId = { unsafe: true };
  const plan = planCanonicalRelationships(dataset);
  const categories = conflictCategories(plan);
  assert(categories.has("missing-employee-reference"));
  assert(categories.has("malformed-project-reference"));
  assert.equal(actionFor(plan, "kpis"), undefined);
});

test("malformed or empty assignment arrays are conflicts", () => {
  for (const assignedEmployeeIds of [null, [], ["missing"]]) {
    const dataset = baseDataset();
    dataset.projects[0].data.assignedEmployeeIds = assignedEmployeeIds;
    const plan = planCanonicalRelationships(dataset);
    assert(plan.conflicts.length > 0);
    assert.equal(actionFor(plan, "projects"), undefined);
  }
});

test("existing legacy KPI records retain an empty projectId while employee IDs migrate", () => {
  const dataset = baseDataset();
  dataset.kpis[0].data.projectId = null;
  dataset.kpis[0].data.empId = 2;
  const plan = planCanonicalRelationships(dataset);
  assert.deepEqual(actionFor(plan, "kpis").changes, { empId: "employee-b" });
  assert.equal(dataset.kpis[0].data.projectId, null);
});

test("a missing write version blocks a planned update", () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = 2;
  dataset.leaves[0].version = null;
  const plan = planCanonicalRelationships(dataset);
  assert(conflictCategories(plan).has("missing-write-precondition"));
  assert.equal(actionFor(plan, "leaves"), undefined);
});

test("Leave Balance relocation rejects a conflicting canonical destination", () => {
  const dataset = baseDataset();
  dataset.leaveBalances = [
    document("2", { Annual: { t: 15, u: 2, r: 13 } }),
    document("employee-b", { Annual: { t: 15, u: 3, r: 12 } }),
  ];
  const plan = planCanonicalRelationships(dataset);
  assert(conflictCategories(plan).has("leave-balance-destination-conflict"));
  assert.equal(actionFor(plan, "leaveBalances", "2"), undefined);
});

test("matching Leave Balance destinations create a safe cleanup-only action", () => {
  const dataset = baseDataset();
  const balances = { Annual: { t: 15, u: 2, r: 13 } };
  dataset.leaveBalances = [document("2", balances), document("employee-b", { ...balances })];
  const plan = planCanonicalRelationships(dataset);
  const action = actionFor(plan, "leaveBalances", "2");
  assert.equal(plan.conflicts.length, 0);
  assert.equal(action.mode, "cleanup-source");
  assert.equal(action.writeCount, 1);
});

test("authLinks are validated but never included in migration writes", () => {
  const dataset = baseDataset();
  dataset.employees[0].data.uid = "auth-a";
  dataset.authLinks = [document("auth-a", {
    employeeId: "employee-a",
    createdAt: NOW,
    updatedAt: NOW,
  })];
  const plan = planCanonicalRelationships(dataset);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.actions.some((action) => action.collection === "authLinks"), false);
  assert.equal(plan.stats.authLinks.noOps, 1);
});

test("malformed, noncanonical, duplicate, and UID-conflicting authLinks fail closed", async (t) => {
  await t.test("malformed", () => {
    const dataset = baseDataset();
    dataset.authLinks = [document("auth-a", { employeeId: "employee-a" })];
    assert(conflictCategories(planCanonicalRelationships(dataset)).has("malformed-auth-link"));
  });
  await t.test("noncanonical", () => {
    const dataset = baseDataset();
    dataset.employees[0].data.uid = "auth-a";
    dataset.authLinks = [document("auth-a", { employeeId: 1, createdAt: NOW, updatedAt: NOW })];
    assert(conflictCategories(planCanonicalRelationships(dataset)).has("noncanonical-auth-link"));
  });
  await t.test("UID conflict", () => {
    const dataset = baseDataset();
    dataset.employees[0].data.uid = "different-auth";
    dataset.authLinks = [document("auth-a", {
      employeeId: "employee-a", createdAt: NOW, updatedAt: NOW,
    })];
    assert(conflictCategories(planCanonicalRelationships(dataset)).has("auth-link-uid-conflict"));
  });
  await t.test("duplicate target", () => {
    const dataset = baseDataset();
    dataset.employees[0].data.uid = "auth-a";
    dataset.authLinks = [
      document("auth-a", { employeeId: "employee-a", createdAt: NOW, updatedAt: NOW }),
      document("auth-b", { employeeId: "employee-a", createdAt: NOW, updatedAt: NOW }),
    ];
    const categories = conflictCategories(planCanonicalRelationships(dataset));
    assert(categories.has("auth-link-uid-conflict"));
    assert(categories.has("duplicate-auth-link-target"));
  });
});

test("employees with linked UIDs require an exact authLink", () => {
  const dataset = baseDataset();
  dataset.employees[0].data.uid = "auth-a";
  const plan = planCanonicalRelationships(dataset);
  assert(conflictCategories(plan).has("missing-or-conflicting-auth-link"));
});

test("summaries contain aggregates and safe non-personal references only", () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = "missing";
  dataset.employees[0].data.sensitiveMarker = "must-not-appear";
  const summaryText = JSON.stringify(summarizePlan(planCanonicalRelationships(dataset)));
  assert(!summaryText.includes("must-not-appear"));
  assert(summaryText.includes("leaves/leave-a"));
  assert(!summaryText.includes("employee-a"));
});

test("dry-run is the executor default and performs zero writes", async () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = 2;
  let applyCalls = 0;
  const migration = createCanonicalRelationshipMigration({
    repository: mockRepository(dataset, async () => {
      applyCalls += 1;
      return { writes: 1 };
    }),
  });
  const plan = await migration.planMigration();
  const result = await migration.executeMigration(plan);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(applyCalls, 0);
});

test("apply requires exact project confirmation and an unambiguous target", async () => {
  const dataset = baseDataset();
  const repository = mockRepository(dataset);
  const plan = planCanonicalRelationships(dataset);
  for (const configuration of [
    { environment: { projectId: "confirmed", target: "production", emulator: false }, confirm: "wrong", code: "confirmation-required" },
    { environment: { projectId: "confirmed", target: "production", emulator: true }, confirm: "confirmed", code: "ambiguous-target" },
    { environment: { projectId: "confirmed", target: "emulator", emulator: false }, confirm: "confirmed", code: "ambiguous-target" },
  ]) {
    const migration = createCanonicalRelationshipMigration({ repository, environment: configuration.environment });
    await assert.rejects(
      migration.executeMigration(plan, { apply: true, confirmProjectId: configuration.confirm }),
      (error) => error.code === configuration.code,
    );
  }
});

test("apply refuses every unresolved conflict before repository writes", async () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = "missing";
  let applyCalls = 0;
  const migration = createCanonicalRelationshipMigration({
    repository: mockRepository(dataset, async () => {
      applyCalls += 1;
    }),
    environment: { projectId: "confirmed", target: "production", emulator: false },
  });
  const plan = await migration.planMigration();
  await assert.rejects(
    migration.executeMigration(plan, { apply: true, confirmProjectId: "confirmed" }),
    (error) => error.code === "conflicts-present",
  );
  assert.equal(applyCalls, 0);
});

test("apply chunks writes without splitting actions or exceeding the configured limit", async () => {
  const dataset = baseDataset();
  dataset.leaves = Array.from({ length: 12 }, (_, index) =>
    document(`leave-${index}`, { empId: 2 }, `leave-version-${index}`));
  const chunks = [];
  const migration = createCanonicalRelationshipMigration({
    repository: mockRepository(dataset, async (actions) => {
      chunks.push(actions);
      return { writes: actions.reduce((total, action) => total + action.writeCount, 0) };
    }),
    environment: { projectId: "confirmed", target: "production", emulator: false },
    writeLimit: 5,
  });
  const plan = await migration.planMigration();
  const result = await migration.executeMigration(plan, {
    apply: true,
    confirmProjectId: "confirmed",
  });
  assert.deepEqual(chunks.map((chunk) => chunk.length), [5, 5, 2]);
  assert(chunks.every((chunk) =>
    chunk.reduce((total, action) => total + action.writeCount, 0) <= 5));
  assert.equal(result.writes, 12);
});

test("repository precondition failures are mapped without exposing raw errors", async () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = 2;
  const migration = createCanonicalRelationshipMigration({
    repository: mockRepository(dataset, async () => {
      const error = new Error("raw database detail");
      error.code = "precondition-failed";
      throw error;
    }),
    environment: { projectId: "confirmed", target: "production", emulator: false },
  });
  const plan = await migration.planMigration();
  await assert.rejects(
    migration.executeMigration(plan, { apply: true, confirmProjectId: "confirmed" }),
    (error) => error.code === "precondition-failed" && !error.message.includes("raw database detail"),
  );
});

function memoryFirestore(dataset) {
  const collections = new Map();
  for (const collection of COLLECTIONS) {
    const records = new Map();
    (dataset[collection] || []).forEach((item) => records.set(item.id, {
      data: structuredClone(item.data),
      version: item.version,
    }));
    collections.set(collection, records);
  }
  let versionCounter = 0;
  const reference = (collection, id) => ({ collection, id });
  const snapshot = (ref) => {
    const record = collections.get(ref.collection).get(ref.id);
    return {
      exists: Boolean(record),
      data: () => structuredClone(record.data),
      updateTime: record?.version,
    };
  };
  const firestore = {
    collection(name) {
      return {
        doc: (id) => reference(name, id),
        async get() {
          return {
            docs: [...collections.get(name).entries()].map(([id, record]) => ({
              id,
              data: () => structuredClone(record.data),
              updateTime: record.version,
            })),
          };
        },
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: async (ref) => snapshot(ref),
        update: (ref, changes) => writes.push({ kind: "update", ref, changes }),
        create: (ref, data) => writes.push({ kind: "create", ref, data }),
        delete: (ref) => writes.push({ kind: "delete", ref }),
      };
      const result = await callback(transaction);
      writes.forEach((write) => {
        const records = collections.get(write.ref.collection);
        if (write.kind === "update") {
          const record = records.get(write.ref.id);
          record.data = { ...record.data, ...structuredClone(write.changes) };
          record.version = `applied:${versionCounter += 1}`;
        } else if (write.kind === "create") {
          if (records.has(write.ref.id)) throw new Error("create conflict");
          records.set(write.ref.id, {
            data: structuredClone(write.data),
            version: `applied:${versionCounter += 1}`,
          });
        } else {
          records.delete(write.ref.id);
        }
      });
      return result;
    },
  };
  return { firestore, collections };
}

test("interrupted Leave Balance relocation is completed idempotently", async () => {
  const dataset = baseDataset();
  const balances = { Annual: { t: 15, u: 2, r: 13 } };
  dataset.leaveBalances = [document("2", balances, "source-version")];
  const plan = planCanonicalRelationships(dataset);
  const memory = memoryFirestore(dataset);
  memory.collections.get("leaveBalances").set("employee-b", {
    data: structuredClone(balances),
    version: "interrupted-create",
  });
  const repository = createAdminMigrationRepository(memory.firestore);
  const result = await repository.applyChunk(plan.actions);
  assert.equal(result.writes, 1);
  assert.equal(memory.collections.get("leaveBalances").has("2"), false);
  assert.deepEqual(memory.collections.get("leaveBalances").get("employee-b").data, balances);

  const rerunDataset = await repository.loadCollections([...COLLECTIONS]);
  const rerunPlan = planCanonicalRelationships(rerunDataset);
  assert.equal(rerunPlan.actions.length, 0);
});

test("a concurrent Leave Balance destination conflict causes no partial relocation", async () => {
  const dataset = baseDataset();
  const sourceBalances = { Annual: { t: 15, u: 2, r: 13 } };
  dataset.leaveBalances = [document("2", sourceBalances, "source-version")];
  const plan = planCanonicalRelationships(dataset);
  const memory = memoryFirestore(dataset);
  const conflictingBalances = { Annual: { t: 15, u: 3, r: 12 } };
  memory.collections.get("leaveBalances").set("employee-b", {
    data: structuredClone(conflictingBalances),
    version: "concurrent-create",
  });
  const repository = createAdminMigrationRepository(memory.firestore);
  await assert.rejects(
    repository.applyChunk(plan.actions),
    (error) => error.code === "precondition-failed",
  );
  assert.deepEqual(memory.collections.get("leaveBalances").get("2").data, sourceBalances);
  assert.deepEqual(
    memory.collections.get("leaveBalances").get("employee-b").data,
    conflictingBalances,
  );
});

test("Admin repository rejects stale update preconditions without partial writes", async () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = 2;
  const plan = planCanonicalRelationships(dataset);
  const memory = memoryFirestore(dataset);
  memory.collections.get("leaves").get("leave-a").version = "changed-after-plan";
  const repository = createAdminMigrationRepository(memory.firestore);
  await assert.rejects(
    repository.applyChunk(plan.actions),
    (error) => error.code === "precondition-failed",
  );
  assert.equal(memory.collections.get("leaves").get("leave-a").data.empId, 2);
});

test("CLI defaults to dry-run and requires explicit target and apply confirmation", () => {
  assert.deepEqual(parseCliArguments(["--target=production"]), {
    apply: false,
    confirmProjectId: null,
    target: "production",
  });
  assert.deepEqual(
    parseCliArguments(["--target=emulator", "--apply", "--confirm-project=confirmed"]),
    { apply: true, confirmProjectId: "confirmed", target: "emulator" },
  );
  assert.throws(() => parseCliArguments([]), (error) => error.code === "ambiguous-target");
  assert.throws(
    () => parseCliArguments(["--target=production", "--apply"]),
    (error) => error.code === "confirmation-required",
  );
});

test("CLI rejects emulator/production ambiguity before Admin initialization", async () => {
  let initializeCalls = 0;
  await assert.rejects(
    runCli(["--target=production"], {
      env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      admin: {
        apps: [],
        initializeApp() {
          initializeCalls += 1;
        },
      },
    }),
    (error) => error.code === "ambiguous-target",
  );
  assert.equal(initializeCalls, 0);
});

test("mocked CLI dry-run loads data but never opens a write transaction", async () => {
  const dataset = baseDataset();
  dataset.leaves[0].data.empId = 2;
  const memory = memoryFirestore(dataset);
  let transactions = 0;
  const originalTransaction = memory.firestore.runTransaction;
  memory.firestore.runTransaction = async (...args) => {
    transactions += 1;
    return originalTransaction(...args);
  };
  const output = [];
  const result = await runCli(["--target=production"], {
    env: {},
    admin: {
      apps: [],
      initializeApp: () => ({ options: { projectId: "confirmed" } }),
      firestore: () => memory.firestore,
    },
    output: (value) => output.push(value),
  });
  assert.equal(result.dryRun, true);
  assert.equal(transactions, 0);
  assert.equal(output.length, 1);
  assert(!output[0].includes("confirmed"));
});

test("invalid datasets and forged plans fail safely", async () => {
  const plan = planCanonicalRelationships({});
  assert.equal(plan.conflicts.length, COLLECTIONS.length);
  const migration = createCanonicalRelationshipMigration({
    repository: mockRepository(baseDataset()),
  });
  await assert.rejects(
    migration.executeMigration({ actions: [], conflicts: [], stats: {} }),
    (error) => error.code === "invalid-plan",
  );
});
