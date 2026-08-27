/* global __dirname, require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ProjectMutationServiceError,
  createProjectMutationService,
} = require("./projectMutationService");

const NOW = "2026-08-22T09:30:00.000Z";
const CREATED_AT = "2026-07-01T00:00:00.000Z";
const UPDATED_AT = "2026-07-02T00:00:00.000Z";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MockFirestore {
  constructor() {
    this.data = new Map();
    this.autoId = 0;
    this.nextAutoId = null;
    this.unrestrictedQueries = 0;
    this.transactionAttempts = 0;
    this.commits = 0;
    this.failTransactionCode = null;
    this.writeLog = [];
  }

  key(collectionName, id) {
    return `${collectionName}/${id}`;
  }

  seed(collectionName, id, value) {
    this.data.set(this.key(collectionName, String(id)), clone(value));
  }

  read(collectionName, id) {
    return clone(this.data.get(this.key(collectionName, String(id))));
  }

  collection(collectionName) {
    return {
      doc: (suppliedId) => {
        const id = suppliedId === undefined
          ? this.nextAutoId || `project-auto-${++this.autoId}`
          : String(suppliedId);
        this.nextAutoId = null;
        return { id, collectionName };
      },
      get: () => {
        this.unrestrictedQueries += 1;
        throw new Error("Unrestricted collection reads are forbidden.");
      },
      where: () => {
        this.unrestrictedQueries += 1;
        throw new Error("Collection queries are forbidden in this service.");
      },
    };
  }

  async runTransaction(callback) {
    this.transactionAttempts += 1;
    const staged = [];
    const transaction = {
      get: async (reference) => {
        const key = this.key(reference.collectionName, reference.id);
        const exists = this.data.has(key);
        return {
          exists,
          data: () => clone(this.data.get(key)),
        };
      },
      create: (reference, value) => {
        const key = this.key(reference.collectionName, reference.id);
        if (this.data.has(key) || staged.some((entry) => entry.key === key)) {
          const error = new Error("already exists");
          error.code = "already-exists";
          throw error;
        }
        staged.push({ type: "create", key, value: clone(value) });
      },
      set: (reference, value) => {
        staged.push({
          type: "set",
          key: this.key(reference.collectionName, reference.id),
          value: clone(value),
        });
      },
      delete: (reference) => {
        staged.push({
          type: "delete",
          key: this.key(reference.collectionName, reference.id),
        });
      },
    };

    const result = await callback(transaction);
    if (this.failTransactionCode) {
      const error = new Error("transaction failed");
      error.code = this.failTransactionCode;
      throw error;
    }
    staged.forEach((entry) => {
      if (entry.type === "delete") this.data.delete(entry.key);
      else this.data.set(entry.key, clone(entry.value));
      this.writeLog.push(clone(entry));
    });
    this.commits += 1;
    return result;
  }
}

function seedPrincipal(firestore, {
  uid = "auth-user",
  id = "principal-1",
  role = "admin",
  department = "Engineering",
  status = "active",
  employeeOverrides = {},
} = {}) {
  firestore.seed("authLinks", uid, {
    employeeId: id,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
  firestore.seed("employees", id, {
    uid,
    role,
    dept: department,
    status,
    name: "Principal",
    salary: 900000,
    ...employeeOverrides,
  });
  return { uid, id };
}

function seedEmployee(firestore, id, {
  role = "employee",
  department = "Engineering",
  status = "active",
  teamLeadId = null,
  ...extra
} = {}) {
  firestore.seed("employees", id, {
    role,
    dept: department,
    status,
    teamLeadId,
    name: `Employee ${id}`,
    email: `employee-${id}@example.com`,
    salary: 500000,
    ...extra,
  });
}

function validProject(overrides = {}) {
  return {
    title: "Migration Project",
    description: "Move the HR platform safely.",
    department: "Engineering",
    teamLeadId: "tl-1",
    assignedEmployeeIds: ["employee-1"],
    startDate: "2026-08-01",
    dueDate: "2026-09-01",
    status: "active",
    ...overrides,
  };
}

function storedProject(overrides = {}) {
  return {
    ...validProject(),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createHarness(principal = {}) {
  const firestore = new MockFirestore();
  const loggerCalls = [];
  const logger = {
    error(message, context) {
      loggerCalls.push({ message, context: clone(context) });
    },
  };
  const identity = seedPrincipal(firestore, principal);
  const service = createProjectMutationService({
    firestore,
    logger,
    clock: () => new Date(NOW),
  });
  return { firestore, loggerCalls, service, ...identity };
}

function seedValidEngineeringReferences(firestore, teamLeadId = "tl-1", employeeId = "employee-1") {
  seedEmployee(firestore, teamLeadId, { role: "tl" });
  seedEmployee(firestore, employeeId, { teamLeadId });
}

async function expectServiceError(promise, { code, reason }) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProjectMutationServiceError);
    assert.equal(error.code, code);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("Admin creates a sanitized company-wide project atomically", async () => {
  const { firestore, service, uid } = createHarness({ role: "admin" });
  seedEmployee(firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(firestore, "sales-employee", {
    department: "Sales",
    teamLeadId: "sales-tl",
  });

  const result = await service.manageProject(uid, {
    operation: "create",
    project: validProject({
      title: "  Sales Launch  ",
      description: "  Real project  ",
      department: "Sales",
      teamLeadId: "sales-tl",
      assignedEmployeeIds: ["sales-employee"],
    }),
  });

  assert.equal(result.id, "project-auto-1");
  assert.equal(result.title, "Sales Launch");
  assert.equal(result.description, "Real project");
  assert.equal(result.createdAt, NOW);
  assert.equal(result.updatedAt, NOW);
  assert.deepEqual(firestore.read("projects", result.id), {
    title: "Sales Launch",
    description: "Real project",
    department: "Sales",
    teamLeadId: "sales-tl",
    assignedEmployeeIds: ["sales-employee"],
    startDate: "2026-08-01",
    dueDate: "2026-09-01",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(firestore.commits, 1);
  assert.equal(firestore.writeLog.length, 1);
  assert.equal(firestore.unrestrictedQueries, 0);
});

test("HR can create and delete valid projects company-wide", async () => {
  const { firestore, service, uid } = createHarness({ role: "hr", department: "People" });
  seedEmployee(firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(firestore, "sales-employee", { department: "Sales", teamLeadId: "sales-tl" });
  firestore.seed("projects", "sales-project", storedProject({
    department: "Sales",
    teamLeadId: "sales-tl",
    assignedEmployeeIds: ["sales-employee"],
  }));
  firestore.seed("kpis", "unrelated-kpi", { projectId: "sales-project", title: "Keep me" });

  const result = await service.manageProject(uid, {
    operation: "delete",
    projectId: "sales-project",
  });

  assert.deepEqual(result, { id: "sales-project", deleted: true });
  assert.equal(firestore.read("projects", "sales-project"), undefined);
  assert.deepEqual(firestore.read("kpis", "unrelated-kpi"), {
    projectId: "sales-project",
    title: "Keep me",
  });
  assert.deepEqual(firestore.writeLog.map((entry) => entry.key), ["projects/sales-project"]);
});

test("Manager creates only inside their department with department references", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedValidEngineeringReferences(firestore);

  const result = await service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  });
  assert.equal(result.department, "Engineering");

  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({ department: "Sales" }),
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
});

test("Manager cannot assign cross-department employees or Team Leads", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedEmployee(firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(firestore, "sales-employee", { department: "Sales", teamLeadId: "sales-tl" });

  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({ teamLeadId: "sales-tl", assignedEmployeeIds: ["sales-employee"] }),
  }), { code: "invalid-argument", reason: "INVALID_TEAM_LEAD_REFERENCE" });
  assert.equal(firestore.writeLog.length, 0);
});

test("Team Lead creates only projects fixed to their department and team", async () => {
  const { firestore, service, uid, id } = createHarness({
    role: "tl",
    id: "tl-1",
  });
  seedEmployee(firestore, "employee-1", { teamLeadId: id });

  const result = await service.manageProject(uid, {
    operation: "create",
    project: validProject({ teamLeadId: id }),
  });
  assert.equal(result.teamLeadId, id);

  seedEmployee(firestore, "employee-2", { teamLeadId: "tl-2" });
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({ teamLeadId: id, assignedEmployeeIds: ["employee-2"] }),
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
});

test("Team Lead cannot select another Team Lead or another department", async () => {
  const { firestore, service, uid, id } = createHarness({ role: "tl", id: "tl-1" });
  seedEmployee(firestore, "tl-2", { role: "tl" });
  seedEmployee(firestore, "employee-1", { teamLeadId: id });
  seedEmployee(firestore, "sales-employee", { department: "Sales", teamLeadId: id });

  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({ teamLeadId: "tl-2" }),
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({
      department: "Sales",
      teamLeadId: id,
      assignedEmployeeIds: ["sales-employee"],
    }),
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
});

test("Team Lead existing-project policy supports direct and assigned-member access", async () => {
  const { firestore, service, uid, id } = createHarness({ role: "tl", id: "tl-1" });
  seedEmployee(firestore, "employee-1", { teamLeadId: id });
  seedEmployee(firestore, "tl-2", { role: "tl" });
  firestore.seed("projects", "direct", storedProject({ teamLeadId: id }));
  firestore.seed("projects", "member", storedProject({
    teamLeadId: "tl-2",
    assignedEmployeeIds: ["employee-1"],
  }));

  const direct = await service.manageProject(uid, { operation: "delete", projectId: "direct" });
  const member = await service.manageProject(uid, { operation: "delete", projectId: "member" });
  assert.equal(direct.deleted, true);
  assert.equal(member.deleted, true);
});

test("Team Lead cannot mutate a project outside direct or member scope", async () => {
  const { firestore, service, uid } = createHarness({ role: "tl", id: "tl-1" });
  seedEmployee(firestore, "tl-2", { role: "tl" });
  seedEmployee(firestore, "employee-2", { teamLeadId: "tl-2" });
  firestore.seed("projects", "other-team", storedProject({
    teamLeadId: "tl-2",
    assignedEmployeeIds: ["employee-2"],
  }));

  await expectServiceError(service.manageProject(uid, {
    operation: "delete",
    projectId: "other-team",
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
  assert.ok(firestore.read("projects", "other-team"));
});

test("Employee role is always rejected before any project write", async () => {
  const { firestore, service, uid } = createHarness({ role: "employee" });
  seedValidEngineeringReferences(firestore);
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "permission-denied", reason: "ROLE_NOT_ALLOWED" });
  assert.equal(firestore.writeLog.length, 0);
});

test("Every managing role supports create, update, and delete in its valid scope", async (context) => {
  for (const role of ["admin", "hr", "manager", "tl"]) {
    await context.test(role, async () => {
      const principal = role === "tl"
        ? { role, id: "tl-1" }
        : { role };
      const { firestore, service, uid } = createHarness(principal);
      if (role !== "tl") seedEmployee(firestore, "tl-1", { role: "tl" });
      seedEmployee(firestore, "employee-1", { teamLeadId: "tl-1" });

      const created = await service.manageProject(uid, {
        operation: "create",
        project: validProject(),
      });
      const updated = await service.manageProject(uid, {
        operation: "update",
        projectId: created.id,
        project: validProject({ title: `Updated by ${role}` }),
      });
      const deleted = await service.manageProject(uid, {
        operation: "delete",
        projectId: created.id,
      });

      assert.equal(updated.title, `Updated by ${role}`);
      assert.deepEqual(deleted, { id: created.id, deleted: true });
      assert.equal(firestore.read("projects", created.id), undefined);
    });
  }
});

test("Employee is rejected for create, update, and delete", async (context) => {
  for (const operation of ["create", "update", "delete"]) {
    await context.test(operation, async () => {
      const { firestore, service, uid } = createHarness({ role: "employee" });
      seedValidEngineeringReferences(firestore);
      firestore.seed("projects", "project-1", storedProject());
      const input = operation === "create"
        ? { operation, project: validProject() }
        : operation === "update"
          ? { operation, projectId: "project-1", project: validProject() }
          : { operation, projectId: "project-1" };
      await expectServiceError(service.manageProject(uid, input), {
        code: "permission-denied",
        reason: "ROLE_NOT_ALLOWED",
      });
      assert.equal(firestore.writeLog.length, 0);
    });
  }
});

test("Inactive principals are rejected", async () => {
  const { firestore, service, uid } = createHarness({ role: "admin", status: "inactive" });
  seedValidEngineeringReferences(firestore);
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "permission-denied", reason: "PRINCIPAL_INACTIVE" });
  assert.equal(firestore.writeLog.length, 0);
});

test("Missing and conflicting authenticated principals are safely rejected", async (context) => {
  await context.test("missing auth link", async () => {
    const firestore = new MockFirestore();
    const service = createProjectMutationService({
      firestore,
      logger: { error() {} },
      clock: () => NOW,
    });
    await expectServiceError(service.manageProject("unknown", {
      operation: "delete",
      projectId: "project-1",
    }), { code: "failed-precondition", reason: "AUTH_LINK_MISSING" });
  });

  await context.test("UID mismatch", async () => {
    const { service, uid } = createHarness({ employeeOverrides: { uid: "different-uid" } });
    await expectServiceError(service.manageProject(uid, {
      operation: "delete",
      projectId: "project-1",
    }), { code: "failed-precondition", reason: "PRINCIPAL_UID_MISMATCH" });
  });
});

test("Missing, inactive, wrong-role, and cross-department references are rejected", async (context) => {
  const cases = [
    ["missing employee", null, "employee-1", "EMPLOYEE_REFERENCE_NOT_FOUND"],
    ["inactive employee", { status: "inactive", teamLeadId: "tl-1" }, "employee-1", "INVALID_EMPLOYEE_REFERENCE"],
    ["wrong employee role", { role: "manager", teamLeadId: "tl-1" }, "employee-1", "INVALID_EMPLOYEE_REFERENCE"],
    ["cross-department employee", { department: "Sales", teamLeadId: "tl-1" }, "employee-1", "INVALID_EMPLOYEE_REFERENCE"],
  ];
  for (const [name, employee, employeeId, reason] of cases) {
    await context.test(name, async () => {
      const { firestore, service, uid } = createHarness();
      seedEmployee(firestore, "tl-1", { role: "tl" });
      if (employee) seedEmployee(firestore, employeeId, employee);
      await expectServiceError(service.manageProject(uid, {
        operation: "create",
        project: validProject(),
      }), { code: "invalid-argument", reason });
      assert.equal(firestore.writeLog.length, 0);
    });
  }

  await context.test("inactive Team Lead", async () => {
    const { firestore, service, uid } = createHarness();
    seedEmployee(firestore, "tl-1", { role: "tl", status: "inactive" });
    seedEmployee(firestore, "employee-1", { teamLeadId: "tl-1" });
    await expectServiceError(service.manageProject(uid, {
      operation: "create",
      project: validProject(),
    }), { code: "invalid-argument", reason: "INVALID_TEAM_LEAD_REFERENCE" });
  });

  await context.test("wrong-role Team Lead", async () => {
    const { firestore, service, uid } = createHarness();
    seedEmployee(firestore, "tl-1", { role: "manager" });
    seedEmployee(firestore, "employee-1", { teamLeadId: "tl-1" });
    await expectServiceError(service.manageProject(uid, {
      operation: "create",
      project: validProject(),
    }), { code: "invalid-argument", reason: "INVALID_TEAM_LEAD_REFERENCE" });
  });

  await context.test("Team Lead cannot also be an assigned employee", async () => {
    const { firestore, service, uid } = createHarness();
    seedEmployee(firestore, "tl-1", { role: "tl" });
    await expectServiceError(service.manageProject(uid, {
      operation: "create",
      project: validProject({ assignedEmployeeIds: ["tl-1"] }),
    }), { code: "invalid-argument", reason: "INVALID_EMPLOYEE_REFERENCE" });
  });
});

test("Numeric and string legacy IDs normalize consistently", async () => {
  const { firestore, service, uid } = createHarness();
  seedEmployee(firestore, "5", { role: "tl" });
  seedEmployee(firestore, "7", { teamLeadId: 5 });

  const result = await service.manageProject(uid, {
    operation: "create",
    project: validProject({ teamLeadId: 5, assignedEmployeeIds: [7] }),
  });
  assert.equal(result.teamLeadId, "5");
  assert.deepEqual(result.assignedEmployeeIds, ["7"]);
  assert.deepEqual(firestore.read("projects", result.id).assignedEmployeeIds, ["7"]);
});

test("Numeric/string duplicate assignments are rejected before transaction", async () => {
  const { firestore, service, uid } = createHarness();
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject({ assignedEmployeeIds: [7, "7"] }),
  }), { code: "invalid-argument", reason: "DUPLICATE_ASSIGNMENT" });
  assert.equal(firestore.transactionAttempts, 0);
});

test("Invalid status, dates, fields, schema, and protected metadata are rejected", async (context) => {
  const cases = [
    ["status", validProject({ status: "paused" }), "INVALID_PROJECT_STATUS"],
    ["start date", validProject({ startDate: "not-a-date" }), "INVALID_PROJECT_DATE"],
    ["date order", validProject({ startDate: "2026-09-02", dueDate: "2026-09-01" }), "INVALID_PROJECT_DATE_ORDER"],
    ["empty title", validProject({ title: "  " }), "INVALID_PROJECT_FIELD"],
    ["empty assignments", validProject({ assignedEmployeeIds: [] }), "ASSIGNMENT_REQUIRED"],
    ["protected createdAt", { ...validProject(), createdAt: CREATED_AT }, "PROTECTED_PROJECT_FIELD"],
    ["protected id", { ...validProject(), id: "injected" }, "PROTECTED_PROJECT_FIELD"],
    ["unknown field", { ...validProject(), arbitrary: true }, "INVALID_PROJECT_SCHEMA"],
  ];
  for (const [name, project, reason] of cases) {
    await context.test(name, async () => {
      const { firestore, service, uid } = createHarness();
      await expectServiceError(service.manageProject(uid, { operation: "create", project }), {
        code: "invalid-argument",
        reason,
      });
      assert.equal(firestore.transactionAttempts, 0);
    });
  }
});

test("Unknown top-level fields and operation shapes are rejected", async () => {
  const { firestore, service, uid } = createHarness();
  await expectServiceError(service.manageProject(uid, {
    operation: "delete",
    projectId: "project-1",
    role: "admin",
  }), { code: "invalid-argument", reason: "INVALID_OPERATION_SCHEMA" });
  await expectServiceError(service.manageProject(uid, {
    operation: "archive",
    projectId: "project-1",
  }), { code: "invalid-argument", reason: "INVALID_OPERATION" });
  assert.equal(firestore.transactionAttempts, 0);
});

test("Update revalidates latest project and preserves immutable creation metadata", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedValidEngineeringReferences(firestore);
  firestore.seed("projects", "project-1", storedProject({
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    legacyInternalField: "remove me",
  }));

  const result = await service.manageProject(uid, {
    operation: "update",
    projectId: "project-1",
    project: validProject({ title: "Updated" }),
  });

  assert.equal(result.id, "project-1");
  assert.equal(result.createdAt, CREATED_AT);
  assert.equal(result.updatedAt, NOW);
  const stored = firestore.read("projects", "project-1");
  assert.equal(stored.createdAt, CREATED_AT);
  assert.equal(stored.updatedAt, NOW);
  assert.equal(stored.legacyInternalField, undefined);
  assert.equal(stored.id, undefined);
});

test("Stale Manager authorization is rejected from the latest transaction record", async () => {
  const { firestore, service, uid } = createHarness({ role: "manager" });
  seedEmployee(firestore, "sales-tl", { role: "tl", department: "Sales" });
  seedEmployee(firestore, "sales-employee", { department: "Sales", teamLeadId: "sales-tl" });
  firestore.seed("projects", "moved-project", storedProject({
    department: "Sales",
    teamLeadId: "sales-tl",
    assignedEmployeeIds: ["sales-employee"],
  }));

  await expectServiceError(service.manageProject(uid, {
    operation: "update",
    projectId: "moved-project",
    project: validProject(),
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
  assert.equal(firestore.writeLog.length, 0);
});

test("Stale Team Lead assignment authorization is rejected", async () => {
  const { firestore, service, uid } = createHarness({ role: "tl", id: "tl-1" });
  seedEmployee(firestore, "tl-2", { role: "tl" });
  seedEmployee(firestore, "employee-2", { teamLeadId: "tl-2" });
  firestore.seed("projects", "reassigned", storedProject({
    teamLeadId: "tl-2",
    assignedEmployeeIds: ["employee-2"],
  }));

  await expectServiceError(service.manageProject(uid, {
    operation: "delete",
    projectId: "reassigned",
  }), { code: "permission-denied", reason: "PROJECT_SCOPE_DENIED" });
});

test("Missing projects are safe not-found failures", async () => {
  const { service, uid } = createHarness();
  await expectServiceError(service.manageProject(uid, {
    operation: "delete",
    projectId: "missing-project",
  }), { code: "not-found", reason: "PROJECT_NOT_FOUND" });
});

test("Missing references in the latest stored project are data-integrity failures", async () => {
  const { firestore, service, uid } = createHarness();
  seedEmployee(firestore, "tl-1", { role: "tl" });
  firestore.seed("projects", "broken-project", storedProject());
  await expectServiceError(service.manageProject(uid, {
    operation: "delete",
    projectId: "broken-project",
  }), { code: "failed-precondition", reason: "PROJECT_REFERENCE_INVALID" });
  assert.ok(firestore.read("projects", "broken-project"));
  assert.equal(firestore.writeLog.length, 0);
});

test("Create uses create-only semantics and never overwrites a collision", async () => {
  const { firestore, service, uid } = createHarness();
  seedValidEngineeringReferences(firestore);
  firestore.nextAutoId = "existing-project";
  firestore.seed("projects", "existing-project", { sentinel: true });

  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "already-exists", reason: "PROJECT_ALREADY_EXISTS" });
  assert.deepEqual(firestore.read("projects", "existing-project"), { sentinel: true });
  assert.equal(firestore.commits, 0);
});

test("Transaction conflicts produce no partial project writes", async () => {
  const { firestore, service, uid } = createHarness();
  seedValidEngineeringReferences(firestore);
  firestore.failTransactionCode = "aborted";

  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "aborted", reason: "PROJECT_TRANSACTION_CONFLICT" });
  assert.equal(firestore.read("projects", "project-auto-1"), undefined);
  assert.equal(firestore.writeLog.length, 0);
  assert.equal(firestore.commits, 0);
});

test("Reference validation failure leaves no partial state", async () => {
  const { firestore, service, uid } = createHarness();
  seedEmployee(firestore, "tl-1", { role: "tl" });
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "invalid-argument", reason: "EMPLOYEE_REFERENCE_NOT_FOUND" });
  assert.equal(firestore.writeLog.length, 0);
  assert.equal(firestore.commits, 0);
});

test("Returned project is strictly sanitized and contains no employee or auth data", async () => {
  const { firestore, service, uid } = createHarness();
  seedValidEngineeringReferences(firestore);
  const result = await service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "assignedEmployeeIds",
    "createdAt",
    "department",
    "description",
    "dueDate",
    "id",
    "startDate",
    "status",
    "teamLeadId",
    "title",
    "updatedAt",
  ]);
  for (const forbidden of [
    "email", "salary", "uid", "role", "token", "authLink", "employee", "credentials",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, forbidden), false);
  }
});

test("No operation performs an unrestricted collection query", async () => {
  const { firestore, service, uid } = createHarness();
  seedValidEngineeringReferences(firestore);
  firestore.seed("projects", "project-1", storedProject());
  await service.manageProject(uid, {
    operation: "update",
    projectId: "project-1",
    project: validProject({ title: "Updated" }),
  });
  await service.manageProject(uid, { operation: "delete", projectId: "project-1" });
  await service.manageProject(uid, { operation: "create", project: validProject() });
  assert.equal(firestore.unrestrictedQueries, 0);
});

test("Internal failures log only a safe reason without identity or project data", async () => {
  const { firestore, loggerCalls, service, uid } = createHarness();
  seedValidEngineeringReferences(firestore);
  firestore.failTransactionCode = "unknown-backend-error";
  await expectServiceError(service.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "internal", reason: "PROJECT_TRANSACTION_FAILED" });
  assert.equal(loggerCalls.length, 1);
  assert.deepEqual(loggerCalls[0].context, {
    event: "project_mutation_service_failed",
    reason: "PROJECT_TRANSACTION_FAILED",
  });
  const serialized = JSON.stringify(loggerCalls);
  assert.equal(serialized.includes(uid), false);
  assert.equal(serialized.includes("Migration Project"), false);
  assert.equal(serialized.includes("employee-1"), false);
});

test("Service configuration, authentication, and clock failures are typed", async () => {
  assert.throws(
    () => createProjectMutationService({ firestore: {}, logger: {}, clock: null }),
    (error) => error instanceof ProjectMutationServiceError
      && error.reason === "INVALID_SERVICE_CONFIGURATION",
  );

  const { service } = createHarness();
  await expectServiceError(service.manageProject(" ", {
    operation: "delete",
    projectId: "project-1",
  }), { code: "unauthenticated", reason: "INVALID_AUTH_IDENTITY" });

  const firestore = new MockFirestore();
  const { uid } = seedPrincipal(firestore);
  const badClockService = createProjectMutationService({
    firestore,
    logger: { error() {} },
    clock: () => "not-a-time",
  });
  await expectServiceError(badClockService.manageProject(uid, {
    operation: "create",
    project: validProject(),
  }), { code: "internal", reason: "CLOCK_FAILED" });
});

test("index exports exactly five callables and manageProject accepts only UID plus picked operation data", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const exports = [...indexSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*onCall/g)]
    .map((match) => match[1]);
  assert.deepEqual(exports, [
    "inviteEmployee",
    "linkLegacyEmployeeUid",
    "verifyAuthSession",
    "getScopedWorkspace",
    "manageProject",
  ]);
  const callable = indexSource.slice(indexSource.indexOf("exports.manageProject = onCall"));
  assert.match(callable, /request\.auth\?\.uid/);
  assert.match(callable, /projectOperationInput\(request\.data\)/);
  assert.doesNotMatch(callable, /request\.auth\?\.token/);
  assert.doesNotMatch(callable, /request\.data\?\.(role|department|employeeId|teamLeadId|creator)/);
});
