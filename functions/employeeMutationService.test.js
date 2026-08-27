/* global __dirname, require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EmployeeMutationServiceError,
  createEmployeeMutationService,
} = require("./employeeMutationService");

const NOW = "2026-08-22T10:00:00.000Z";
const CREATED_AT = "2026-07-01T00:00:00.000Z";
const UPDATED_AT = "2026-07-02T00:00:00.000Z";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MockFirestore {
  constructor() {
    this.data = new Map();
    this.unrestrictedQueries = 0;
    this.queryLog = [];
    this.writeLog = [];
    this.transactionCount = 0;
    this.failTransactions = new Set();
    this.beforeTransaction = new Map();
  }

  key(collection, id) {
    return `${collection}/${String(id)}`;
  }

  seed(collection, id, value) {
    this.data.set(this.key(collection, id), clone(value));
  }

  read(collection, id) {
    return clone(this.data.get(this.key(collection, id)));
  }

  collection(collectionName) {
    return {
      doc: (id) => ({ kind: "doc", collectionName, id: String(id) }),
      where: (field, operator, value) => {
        assert.equal(operator, "==");
        return {
          limit: (limit) => ({
            kind: "query", collectionName, field, operator, value, limit,
          }),
        };
      },
      get: () => {
        this.unrestrictedQueries += 1;
        throw new Error("Unrestricted collection reads are forbidden.");
      },
    };
  }

  snapshot(collectionName, id) {
    const key = this.key(collectionName, id);
    return {
      id: String(id),
      exists: this.data.has(key),
      data: () => clone(this.data.get(key)),
    };
  }

  querySnapshot(reference) {
    this.queryLog.push(clone(reference));
    const docs = [];
    const prefix = `${reference.collectionName}/`;
    for (const [key, value] of this.data.entries()) {
      if (!key.startsWith(prefix) || value?.[reference.field] !== reference.value) continue;
      docs.push(this.snapshot(reference.collectionName, key.slice(prefix.length)));
      if (docs.length >= reference.limit) break;
    }
    return { docs };
  }

  async runTransaction(callback) {
    this.transactionCount += 1;
    const attempt = this.transactionCount;
    const hook = this.beforeTransaction.get(attempt);
    if (hook) hook(this);
    const staged = [];
    const transaction = {
      get: async (reference) => reference.kind === "query"
        ? this.querySnapshot(reference)
        : this.snapshot(reference.collectionName, reference.id),
      set: (reference, value) => staged.push({
        type: "set",
        key: this.key(reference.collectionName, reference.id),
        value: clone(value),
      }),
      delete: (reference) => staged.push({
        type: "delete",
        key: this.key(reference.collectionName, reference.id),
      }),
    };
    const result = await callback(transaction);
    if (this.failTransactions.has(attempt)) {
      const error = new Error("transaction aborted");
      error.code = "aborted";
      throw error;
    }
    staged.forEach((entry) => {
      if (entry.type === "delete") this.data.delete(entry.key);
      else this.data.set(entry.key, clone(entry.value));
      this.writeLog.push(clone(entry));
    });
    return result;
  }
}

class MockAuth {
  constructor() {
    this.users = new Map();
    this.calls = [];
    this.failUpdateCalls = new Set();
    this.failDelete = false;
  }

  seed(uid, email, disabled = false) {
    this.users.set(uid, { uid, email, disabled });
  }

  async getUser(uid) {
    this.calls.push({ operation: "getUser" });
    const user = this.users.get(uid);
    if (!user) {
      const error = new Error("missing");
      error.code = "auth/user-not-found";
      throw error;
    }
    return clone(user);
  }

  async getUserByEmail(email) {
    this.calls.push({ operation: "getUserByEmail" });
    const user = [...this.users.values()].find((candidate) =>
      candidate.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      const error = new Error("missing");
      error.code = "auth/user-not-found";
      throw error;
    }
    return clone(user);
  }

  async updateUser(uid, updates) {
    const callNumber = this.calls.filter(({ operation }) => operation === "updateUser").length + 1;
    this.calls.push({ operation: "updateUser", updates: clone(updates) });
    if (this.failUpdateCalls.has(callNumber)) {
      const error = new Error("update failed");
      error.code = "auth/internal-error";
      throw error;
    }
    const current = this.users.get(uid);
    if (!current) {
      const error = new Error("missing");
      error.code = "auth/user-not-found";
      throw error;
    }
    if (updates.email && [...this.users.values()].some((candidate) =>
      candidate.uid !== uid && candidate.email.toLowerCase() === updates.email.toLowerCase())) {
      const error = new Error("duplicate");
      error.code = "auth/email-already-exists";
      throw error;
    }
    this.users.set(uid, { ...current, ...clone(updates) });
    return clone(this.users.get(uid));
  }

  async deleteUser(uid) {
    this.calls.push({ operation: "deleteUser" });
    if (this.failDelete) throw new Error("delete failed");
    if (!this.users.has(uid)) {
      const error = new Error("missing");
      error.code = "auth/user-not-found";
      throw error;
    }
    this.users.delete(uid);
  }
}

function employee(overrides = {}) {
  return {
    name: "Taylor Employee",
    email: "taylor@example.com",
    phone: "0300-0000000",
    dept: "Engineering",
    pos: "Developer",
    basic: 100000,
    allowances: 10000,
    joinDate: "2024-01-15",
    role: "employee",
    status: "active",
    teamLeadId: "tl-1",
    uid: "target-uid",
    empId: "EMP-target-uid",
    createdByUid: "creator-uid",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function seedLink(firestore, uid, employeeId) {
  firestore.seed("authLinks", uid, {
    employeeId,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
}

function createHarness({ role = "admin", department = "Engineering" } = {}) {
  const firestore = new MockFirestore();
  const auth = new MockAuth();
  const logs = [];
  const principalId = "principal-1";
  const callerUid = "caller-uid";
  seedLink(firestore, callerUid, principalId);
  firestore.seed("employees", principalId, employee({
    name: "Principal",
    email: "principal@example.com",
    role,
    dept: department,
    teamLeadId: null,
    uid: callerUid,
    empId: "EMP-principal",
  }));
  auth.seed(callerUid, "principal@example.com", false);
  firestore.seed("departments", "engineering", { name: "Engineering", status: "Active" });
  firestore.seed("departments", "sales", { name: "Sales", status: "Active" });
  firestore.seed("employees", "tl-1", employee({
    name: "Team Lead",
    email: "lead@example.com",
    role: "tl",
    teamLeadId: null,
    uid: null,
    empId: "EMP-TL-1",
  }));
  const service = createEmployeeMutationService({
    auth,
    firestore,
    logger: { error: (message, context) => logs.push({ message, context: clone(context) }) },
    clock: () => new Date(NOW),
  });
  return { auth, firestore, logs, service, callerUid, principalId };
}

function seedTarget(harness, id = "employee-1", overrides = {}, linked = true) {
  const record = employee({
    uid: linked ? "target-uid" : null,
    ...overrides,
  });
  if (!linked) delete record.uid;
  harness.firestore.seed("employees", id, record);
  if (linked) {
    seedLink(harness.firestore, record.uid, id);
    harness.auth.seed(record.uid, record.email, record.status !== "active");
  }
  return id;
}

function updateInput(employeeId, updates) {
  return { operation: "update", employeeId, updates };
}

async function expectError(promise, code, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EmployeeMutationServiceError);
    assert.equal(error.code, code);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("Admin updates an employee with normalized fields, Auth sync, and a sanitized response", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  const result = await harness.service.manageEmployee(harness.callerUid, updateInput(id, {
    name: "  Updated Employee  ",
    email: "  NEW@Example.COM ",
    status: "inactive",
    basic: "120000",
  }));

  assert.equal(result.name, "Updated Employee");
  assert.equal(result.email, "new@example.com");
  assert.equal(result.status, "inactive");
  assert.equal(result.basic, 120000);
  assert.equal(result.createdAt, CREATED_AT);
  assert.equal(result.updatedAt, NOW);
  assert.equal(harness.firestore.read("employees", id).createdAt, CREATED_AT);
  assert.deepEqual(harness.auth.users.get("target-uid"), {
    uid: "target-uid", email: "new@example.com", disabled: true,
  });
  assert.equal(Object.hasOwn(result, "uid"), false);
  assert.equal(Object.hasOwn(result, "createdByUid"), false);
});

test("Admin can manage every role while HR cannot manage or assign Admin/HR", async () => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    const harness = createHarness({ role: "admin" });
    const id = seedTarget(harness, `target-${role}`, { role, teamLeadId: role === "employee" ? "tl-1" : null });
    const result = await harness.service.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" }));
    assert.equal(result.role, role);
  }

  for (const role of ["admin", "hr"]) {
    const harness = createHarness({ role: "hr" });
    const id = seedTarget(harness, `target-${role}`, { role, teamLeadId: null });
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" })),
      "permission-denied",
      "EMPLOYEE_SCOPE_DENIED",
    );
  }
  const hr = createHarness({ role: "hr" });
  const id = seedTarget(hr);
  await expectError(
    hr.service.manageEmployee(hr.callerUid, updateInput(id, { role: "admin" })),
    "permission-denied",
    "EMPLOYEE_SCOPE_DENIED",
  );
});

test("Manager is limited to Team Lead/Employee records in an unchanged own department", async () => {
  const allowed = createHarness({ role: "manager" });
  const id = seedTarget(allowed);
  const promoted = await allowed.service.manageEmployee(allowed.callerUid, updateInput(id, { role: "tl" }));
  assert.equal(promoted.role, "tl");
  assert.equal(Object.hasOwn(promoted, "teamLeadId"), false);

  for (const overrides of [
    { dept: "Sales" },
    { role: "manager", teamLeadId: null },
  ]) {
    const harness = createHarness({ role: "manager" });
    const targetId = seedTarget(harness, "target", overrides);
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(targetId, { phone: "0301" })),
      "permission-denied",
      "EMPLOYEE_SCOPE_DENIED",
    );
  }
  const moving = createHarness({ role: "manager" });
  const movingId = seedTarget(moving);
  await expectError(
    moving.service.manageEmployee(moving.callerUid, updateInput(movingId, { dept: "Sales" })),
    "permission-denied",
    "EMPLOYEE_SCOPE_DENIED",
  );
});

test("Team Lead manages only assigned Employees and cannot change team scope", async () => {
  const allowed = createHarness({ role: "tl" });
  const id = seedTarget(allowed, "employee-1", { teamLeadId: allowed.principalId });
  assert.equal((await allowed.service.manageEmployee(
    allowed.callerUid,
    updateInput(id, { pos: "Senior Developer" }),
  )).pos, "Senior Developer");

  for (const overrides of [
    { teamLeadId: "tl-1" },
    { role: "tl", teamLeadId: null },
    { dept: "Sales", teamLeadId: allowed.principalId },
  ]) {
    const harness = createHarness({ role: "tl" });
    const targetId = seedTarget(harness, "target", overrides);
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(targetId, { phone: "0301" })),
      "permission-denied",
      "EMPLOYEE_SCOPE_DENIED",
    );
  }
});

test("Employee principals cannot update or delete anyone", async () => {
  for (const operation of ["update", "delete"]) {
    const harness = createHarness({ role: "employee" });
    const id = seedTarget(harness);
    const input = operation === "update" ? updateInput(id, { phone: "0301" }) : { operation, employeeId: id };
    await expectError(
      harness.service.manageEmployee(harness.callerUid, input),
      "permission-denied",
      "ROLE_NOT_ALLOWED",
    );
    assert.equal(harness.firestore.writeLog.length, 0);
  }
});

test("self-deletion and self-role changes are denied", async () => {
  const harness = createHarness({ role: "admin" });
  await expectError(
    harness.service.manageEmployee(harness.callerUid, {
      operation: "delete", employeeId: harness.principalId,
    }),
    "permission-denied",
    "SELF_DELETE_DENIED",
  );
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(harness.principalId, { role: "hr" })),
    "permission-denied",
    "SELF_ROLE_CHANGE_DENIED",
  );
});

test("only Admin and HR may change compensation", async () => {
  for (const role of ["manager", "tl"]) {
    const harness = createHarness({ role });
    const id = seedTarget(harness, "target", role === "tl" ? { teamLeadId: harness.principalId } : {});
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, { basic: 200000 })),
      "permission-denied",
      "COMPENSATION_CHANGE_DENIED",
    );
  }
  const hr = createHarness({ role: "hr" });
  const id = seedTarget(hr);
  assert.equal((await hr.service.manageEmployee(hr.callerUid, updateInput(id, {
    basic: 200000, allowances: 20000,
  }))).basic, 200000);
});

test("Team Lead references must be active, same-department Team Leads with normalized IDs", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.firestore.seed("employees", "7", employee({
    role: "tl", uid: null, teamLeadId: null, email: "seven@example.com",
  }));
  assert.equal((await harness.service.manageEmployee(
    harness.callerUid,
    updateInput(id, { teamLeadId: 7 }),
  )).teamLeadId, "7");

  for (const bad of [
    employee({ role: "employee", uid: null, teamLeadId: null }),
    employee({ role: "tl", status: "inactive", uid: null, teamLeadId: null }),
    employee({ role: "tl", dept: "Sales", uid: null, teamLeadId: null }),
  ]) {
    const next = createHarness();
    const targetId = seedTarget(next);
    next.firestore.seed("employees", "bad-tl", bad);
    await expectError(
      next.service.manageEmployee(next.callerUid, updateInput(targetId, { teamLeadId: "bad-tl" })),
      "invalid-argument",
      "INVALID_TEAM_LEAD",
    );
  }
});

test("department references must exist uniquely and be active", async () => {
  for (const setup of ["missing", "inactive", "duplicate"]) {
    const harness = createHarness();
    const id = seedTarget(harness);
    harness.firestore.data.delete(harness.firestore.key("departments", "sales"));
    if (setup === "inactive") harness.firestore.seed("departments", "sales", { name: "Sales", status: "Inactive" });
    if (setup === "duplicate") {
      harness.firestore.seed("departments", "sales-a", { name: "Sales", status: "Active" });
      harness.firestore.seed("departments", "sales-b", { name: "Sales", status: "Active" });
    }
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, { dept: "Sales", teamLeadId: null })),
      "invalid-argument",
      "INVALID_DEPARTMENT",
    );
  }
});

test("email is normalized and duplicate Firestore/Auth emails are rejected before writes", async () => {
  const firestoreDuplicate = createHarness();
  const id = seedTarget(firestoreDuplicate);
  firestoreDuplicate.firestore.seed("employees", "other", employee({
    uid: null, email: "used@example.com",
  }));
  await expectError(
    firestoreDuplicate.service.manageEmployee(
      firestoreDuplicate.callerUid,
      updateInput(id, { email: " USED@example.com " }),
    ),
    "already-exists",
    "EMPLOYEE_EMAIL_EXISTS",
  );

  const authDuplicate = createHarness();
  const authId = seedTarget(authDuplicate);
  authDuplicate.auth.seed("other-uid", "auth-used@example.com");
  await expectError(
    authDuplicate.service.manageEmployee(
      authDuplicate.callerUid,
      updateInput(authId, { email: "AUTH-USED@example.com" }),
    ),
    "already-exists",
    "AUTH_EMAIL_EXISTS",
  );
  assert.equal(authDuplicate.firestore.writeLog.length, 0);
});

test("status changes synchronize the linked Auth disabled state", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  await harness.service.manageEmployee(harness.callerUid, updateInput(id, { status: "INACTIVE" }));
  assert.equal(harness.auth.users.get("target-uid").disabled, true);
  assert.equal(harness.firestore.read("employees", id).status, "inactive");
});

test("protected, credential, timestamp, identity, and unknown fields are rejected", async () => {
  for (const field of [
    "password", "pass", "uid", "authLink", "id", "empId", "createdByUid", "createdAt", "updatedAt",
  ]) {
    const harness = createHarness();
    const id = seedTarget(harness);
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, { [field]: "attack" })),
      "invalid-argument",
      "PROTECTED_EMPLOYEE_FIELD",
    );
  }
  const harness = createHarness();
  const id = seedTarget(harness);
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, { salary: 1 })),
    "invalid-argument",
    "UNSUPPORTED_EMPLOYEE_FIELD",
  );
});

test("malformed fields, statuses, operation shapes, and dates are rejected", async () => {
  const cases = [
    [{ status: "pending" }, "INVALID_STATUS"],
    [{ email: "invalid" }, "INVALID_EMAIL"],
    [{ basic: -1 }, "INVALID_COMPENSATION"],
    [{ joinDate: "2026-02-31" }, "INVALID_JOIN_DATE"],
    [{ role: "owner" }, "INVALID_ROLE"],
  ];
  for (const [updates, reason] of cases) {
    const harness = createHarness();
    const id = seedTarget(harness);
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, updates)),
      "invalid-argument",
      reason,
    );
  }
  const harness = createHarness();
  await expectError(
    harness.service.manageEmployee(harness.callerUid, { operation: "create", employeeId: "x" }),
    "invalid-argument",
    "INVALID_OPERATION",
  );
});

test("UID/auth-link conflicts and malformed principal links fail without writes", async () => {
  for (const mutation of [
    (h) => h.firestore.data.delete(h.firestore.key("authLinks", "target-uid")),
    (h) => h.firestore.seed("authLinks", "target-uid", {
      employeeId: "other", createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    }),
    (h, id) => h.firestore.seed("authLinks", "duplicate-link", {
      employeeId: id, createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    }),
  ]) {
    const harness = createHarness();
    const id = seedTarget(harness);
    mutation(harness, id);
    await expectError(
      harness.service.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" })),
      "failed-precondition",
      "TARGET_UID_CONFLICT",
    );
    assert.equal(harness.firestore.writeLog.length, 0);
  }
});

test("unlinked legacy employees update/delete without guessing an Auth account", async () => {
  const updateHarness = createHarness();
  seedTarget(updateHarness, "7", {}, false);
  const updated = await updateHarness.service.manageEmployee(
    updateHarness.callerUid,
    updateInput(7, { phone: "0307" }),
  );
  assert.equal(updated.id, "7");
  assert.equal(updateHarness.auth.calls.some(({ operation }) => operation === "getUser"), false);

  const deleteHarness = createHarness();
  const deleteId = seedTarget(deleteHarness, "legacy", {}, false);
  const deleted = await deleteHarness.service.manageEmployee(deleteHarness.callerUid, {
    operation: "delete", employeeId: deleteId,
  });
  assert.deepEqual(deleted, {
    employeeId: deleteId, deleted: true, authAccountDeleted: false,
  });
  assert.equal(deleteHarness.auth.calls.some(({ operation }) => operation === "deleteUser"), false);
});

test("latest caller/target scope is revalidated before the Firestore update", async () => {
  const harness = createHarness({ role: "manager" });
  const id = seedTarget(harness);
  harness.firestore.beforeTransaction.set(2, (firestore) => {
    firestore.seed("employees", id, employee({ dept: "Sales" }));
  });
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" })),
    "aborted",
    "EMPLOYEE_TRANSACTION_CONFLICT",
  );
  assert.equal(harness.firestore.writeLog.length, 0);
});

test("Auth update rejection causes no Firestore mutation", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.auth.failUpdateCalls.add(1);
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, { status: "inactive" })),
    "internal",
    "AUTH_UPDATE_FAILED",
  );
  assert.equal(harness.firestore.read("employees", id).status, "active");
  assert.equal(harness.firestore.writeLog.length, 0);
});

test("Firestore failure after Auth update compensates the Auth identity", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.firestore.failTransactions.add(2);
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, {
      email: "changed@example.com", status: "inactive",
    })),
    "aborted",
    "EMPLOYEE_TRANSACTION_CONFLICT",
  );
  assert.deepEqual(harness.auth.users.get("target-uid"), {
    uid: "target-uid", email: "taylor@example.com", disabled: false,
  });
  assert.equal(harness.firestore.read("employees", id).email, "taylor@example.com");
});

test("failed Auth compensation returns only a typed safe partial-cleanup error", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.firestore.failTransactions.add(2);
  harness.auth.failUpdateCalls.add(2);
  await assert.rejects(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, { status: "inactive" })),
    (error) => {
      assert.ok(error instanceof EmployeeMutationServiceError);
      assert.equal(error.reason, "AUTH_COMPENSATION_FAILED");
      assert.deepEqual(error.partialResult, {
        employeeId: id, firestoreUpdated: false, authCleanupPending: true,
      });
      assert.equal(JSON.stringify(error).includes("target-uid"), false);
      return true;
    },
  );
});

test("linked deletion removes only employee identity records and Auth", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  for (const collection of ["projects", "kpis", "attendance", "leaves", "payroll"]) {
    harness.firestore.seed(collection, "history", { empId: id });
  }
  const result = await harness.service.manageEmployee(harness.callerUid, {
    operation: "delete", employeeId: id,
  });
  assert.deepEqual(result, { employeeId: id, deleted: true, authAccountDeleted: true });
  assert.equal(harness.firestore.read("employees", id), undefined);
  assert.equal(harness.firestore.read("authLinks", "target-uid"), undefined);
  assert.equal(harness.auth.users.has("target-uid"), false);
  for (const collection of ["projects", "kpis", "attendance", "leaves", "payroll"]) {
    assert.deepEqual(harness.firestore.read(collection, "history"), { empId: id });
  }
});

test("Manager and Team Lead cannot delete; HR can delete only Manager/TL/Employee", async () => {
  for (const role of ["manager", "tl"]) {
    const harness = createHarness({ role });
    const id = seedTarget(harness, "target", role === "tl" ? { teamLeadId: harness.principalId } : {});
    await expectError(
      harness.service.manageEmployee(harness.callerUid, { operation: "delete", employeeId: id }),
      "permission-denied",
      "EMPLOYEE_SCOPE_DENIED",
    );
  }
  const hr = createHarness({ role: "hr" });
  const allowedId = seedTarget(hr, "allowed", { role: "manager", teamLeadId: null });
  assert.equal((await hr.service.manageEmployee(hr.callerUid, {
    operation: "delete", employeeId: allowedId,
  })).deleted, true);

  const denied = createHarness({ role: "hr" });
  const deniedId = seedTarget(denied, "denied", { role: "admin", teamLeadId: null });
  await expectError(
    denied.service.manageEmployee(denied.callerUid, { operation: "delete", employeeId: deniedId }),
    "permission-denied",
    "EMPLOYEE_SCOPE_DENIED",
  );
});

test("Auth deletion failure leaves Firestore identity records untouched", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.auth.failDelete = true;
  await expectError(
    harness.service.manageEmployee(harness.callerUid, { operation: "delete", employeeId: id }),
    "internal",
    "AUTH_DELETE_FAILED",
  );
  assert.ok(harness.firestore.read("employees", id));
  assert.ok(harness.firestore.read("authLinks", "target-uid"));
  assert.equal(harness.firestore.writeLog.length, 0);
});

test("a database failure after Auth deletion is fail-closed and retry-safe", async () => {
  const harness = createHarness();
  const id = seedTarget(harness);
  harness.firestore.failTransactions.add(2);
  await assert.rejects(
    harness.service.manageEmployee(harness.callerUid, { operation: "delete", employeeId: id }),
    (error) => {
      assert.equal(error.reason, "DELETE_PARTIAL_CLEANUP");
      assert.deepEqual(error.partialResult, {
        employeeId: id, accessRevoked: true, cleanupPending: true,
      });
      return true;
    },
  );
  assert.equal(harness.auth.users.has("target-uid"), false);
  assert.ok(harness.firestore.read("employees", id));

  harness.firestore.failTransactions.clear();
  const retried = await harness.service.manageEmployee(harness.callerUid, {
    operation: "delete", employeeId: id,
  });
  assert.deepEqual(retried, { employeeId: id, deleted: true, authAccountDeleted: false });
  assert.equal(harness.firestore.read("employees", id), undefined);
});

test("all reads are direct or constrained and failed operations stage no unauthorized writes", async () => {
  const harness = createHarness({ role: "manager" });
  const id = seedTarget(harness, "target", { dept: "Sales" });
  await expectError(
    harness.service.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" })),
    "permission-denied",
    "EMPLOYEE_SCOPE_DENIED",
  );
  assert.equal(harness.firestore.unrestrictedQueries, 0);
  assert.equal(harness.firestore.writeLog.length, 0);
  assert.ok(harness.firestore.queryLog.every(({ operator, limit }) => operator === "==" && limit === 2));
});

test("service dependency, identity, clock, and transaction failures are typed and safely logged", async () => {
  assert.throws(
    () => createEmployeeMutationService({ auth: {}, firestore: {}, logger: {}, clock: null }),
    (error) => error instanceof EmployeeMutationServiceError
      && error.reason === "INVALID_SERVICE_CONFIGURATION",
  );
  const harness = createHarness();
  await expectError(
    harness.service.manageEmployee(" ", { operation: "delete", employeeId: "x" }),
    "unauthenticated",
    "INVALID_AUTH_IDENTITY",
  );
  const id = seedTarget(harness);
  const badClock = createEmployeeMutationService({
    auth: harness.auth,
    firestore: harness.firestore,
    logger: { error() {} },
    clock: () => "invalid",
  });
  await expectError(
    badClock.manageEmployee(harness.callerUid, updateInput(id, { phone: "0301" })),
    "internal",
    "CLOCK_FAILED",
  );
});

test("index exports exactly seven callables and manageEmployee receives only UID plus picked operation input", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const direct = [...source.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*onCall/g)].map((match) => match[1]);
  const aliases = [
    ...[...source.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*manageKpiCallable/g)].map((match) => match[1]),
    ...[...source.matchAll(/exports\.([A-Za-z0-9_]+)\s*=\s*manageEmployeeCallable/g)].map((match) => match[1]),
  ];
  assert.deepEqual([...direct, ...aliases], [
    "inviteEmployee",
    "linkLegacyEmployeeUid",
    "verifyAuthSession",
    "getScopedWorkspace",
    "manageProject",
    "manageKpi",
    "manageEmployee",
  ]);
  const callable = source.slice(source.indexOf("const manageEmployeeCallable = onCall"));
  assert.match(callable, /request\.auth\?\.uid/);
  assert.match(callable, /employeeOperationInput\(request\.data\)/);
  assert.doesNotMatch(callable, /request\.auth\?\.token/);
  assert.doesNotMatch(callable, /request\.data\?\.(role|dept|department|uid|authorization)/);
});
