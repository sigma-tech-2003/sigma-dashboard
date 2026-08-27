/* global require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmployeeInvitationServiceError,
  createEmployeeInvitationService,
} = require("./employeeInvitationService");

const FIXED_DATE = new Date("2026-08-21T10:30:00.000Z");

function employeeDocument(id, data) {
  return {
    id,
    data: () => ({ ...data }),
  };
}

function snapshot(documents) {
  return { docs: documents };
}

function validInput(overrides = {}) {
  return {
    name: "  Noor Ahmed  ",
    email: "  NOOR.AHMED@EXAMPLE.COM ",
    phone: "  +92 300 1234567  ",
    dept: "Engineering",
    pos: "  Software Engineer  ",
    basic: "120000.50",
    allowances: "15000",
    joinDate: "2026-08-21",
    role: "employee",
    status: "active",
    ...overrides,
  };
}

function authError(code, message = "raw Admin SDK details") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createHarness(options = {}) {
  const calls = {
    where: [],
    creatorSelect: [],
    creatorLimits: [],
    employeeSelect: [],
    authEmailLookups: [],
    authCreates: [],
    authDeletes: [],
    firestoreCollections: [],
    firestoreDocs: [],
    firestoreCreates: [],
    firestoreSets: [],
    firestoreUpdates: [],
    batchCreates: [],
    batchCommits: 0,
    logs: [],
    clock: 0,
  };

  const createdUid = options.createdUid || "new-auth-uid";
  const firestoreState = {
    employees: new Map(),
    authLinks: new Map(),
  };
  if (options.employeeConflict) {
    firestoreState.employees.set(createdUid, { existing: true });
  }
  if (options.authLinkConflict) {
    firestoreState.authLinks.set(createdUid, { existing: true });
  }

  const creatorData = options.creatorData || {
    uid: "caller-uid",
    role: "admin",
    status: "active",
    dept: "Management",
    email: "admin@example.com",
    basic: 999999,
  };
  const creatorDocuments = options.creatorDocuments || [
    employeeDocument("creator-document", creatorData),
  ];
  const policyDocuments = options.policyDocuments || [
    employeeDocument("creator-document", creatorData),
    employeeDocument("team-lead-document", {
      uid: "team-lead-uid",
      role: "tl",
      status: "active",
      dept: "Engineering",
      email: "team.lead@example.com",
      basic: 500000,
    }),
  ];

  const creatorQuery = {
    select(...fields) {
      calls.creatorSelect.push(fields);
      return this;
    },
    limit(value) {
      calls.creatorLimits.push(value);
      return this;
    },
    async get() {
      if (options.creatorLookupError) throw options.creatorLookupError;
      return snapshot(creatorDocuments);
    },
  };

  const documentReference = (collection, id) => {
    calls.firestoreDocs.push({ collection, id });
    return {
      collection,
      id,
      async create(payload) {
        calls.firestoreCreates.push({ collection, id, payload });
      },
      async set(payload) {
        calls.firestoreSets.push({ collection, id, payload });
      },
      async update(payload) {
        calls.firestoreUpdates.push({ collection, id, payload });
      },
    };
  };

  const employeesCollection = {
    where(...parts) {
      calls.where.push(parts);
      return creatorQuery;
    },
    select(...fields) {
      calls.employeeSelect.push(fields);
      return {
        async get() {
          if (options.employeeLookupError) throw options.employeeLookupError;
          return snapshot(policyDocuments);
        },
      };
    },
    doc(id) {
      return documentReference("employees", id);
    },
  };

  const authLinksCollection = {
    doc(id) {
      return documentReference("authLinks", id);
    },
  };

  const firestore = {
    collection(name) {
      calls.firestoreCollections.push(name);
      if (name === "employees") {
        if (options.collectionError) throw options.collectionError;
        return employeesCollection;
      }
      if (name === "authLinks") {
        if (options.authLinksCollectionError) throw options.authLinksCollectionError;
        return authLinksCollection;
      }
      throw new Error("unexpected collection");
    },
    batch() {
      const operations = [];
      return {
        create(reference, payload) {
          const operation = {
            collection: reference.collection,
            id: reference.id,
            payload,
          };
          operations.push(operation);
          calls.batchCreates.push(operation);
          return this;
        },
        async commit() {
          calls.batchCommits += 1;
          if (options.batchCommitError) throw options.batchCommitError;

          const hasConflict = operations.some(({ collection, id }) =>
            firestoreState[collection].has(id));
          if (hasConflict) throw authError("already-exists", "document already exists");

          for (const { collection, id, payload } of operations) {
            firestoreState[collection].set(id, structuredClone(payload));
          }
        },
      };
    },
  };

  const auth = {
    async getUserByEmail(email) {
      calls.authEmailLookups.push(email);
      if (options.authEmailLookupError) throw options.authEmailLookupError;
      if (options.existingAuthUser) return options.existingAuthUser;
      throw authError("auth/user-not-found");
    },
    async createUser(payload) {
      calls.authCreates.push(payload);
      if (options.authCreateError) throw options.authCreateError;
      return { uid: createdUid };
    },
    async deleteUser(uid) {
      calls.authDeletes.push(uid);
      if (options.authDeleteError) throw options.authDeleteError;
    },
  };

  const logger = {
    error(...parts) {
      calls.logs.push(parts);
      if (options.loggerError) throw options.loggerError;
    },
  };

  const clock = () => {
    calls.clock += 1;
    if (options.clockError) throw options.clockError;
    return options.clockValue || FIXED_DATE;
  };

  const service = createEmployeeInvitationService({ auth, firestore, logger, clock });
  return { service, calls, firestoreState };
}

async function expectServiceError(promise, code, reason) {
  let received;
  try {
    await promise;
  } catch (error) {
    received = error;
  }

  assert.ok(received instanceof EmployeeInvitationServiceError);
  assert.equal(received.name, "EmployeeInvitationServiceError");
  assert.equal(received.code, code);
  assert.equal(received.reason, reason);
  assert.equal(typeof received.message, "string");
  assert.ok(received.message.length > 0);
  return received;
}

function assertNoMutationCalls(calls) {
  assert.equal(calls.authCreates.length, 0);
  assert.equal(calls.authDeletes.length, 0);
  assert.equal(calls.firestoreCreates.length, 0);
  assert.equal(calls.firestoreSets.length, 0);
  assert.equal(calls.firestoreUpdates.length, 0);
  assert.equal(calls.batchCreates.length, 0);
  assert.equal(calls.batchCommits, 0);
}

function assertForbiddenCredentialKeys(value) {
  const forbidden = new Set([
    "password",
    "pass",
    "actionLink",
    "passwordResetLink",
    "resetLink",
    "token",
    "credential",
  ]);

  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `unexpected sensitive key: ${key}`);
    assertForbiddenCredentialKeys(child);
  }
}

test("rejects unauthenticated callers before any data access or mutation", async () => {
  for (const callerUid of [null, undefined, "", "   "]) {
    const { service, calls } = createHarness();
    await expectServiceError(
      service.inviteEmployee(callerUid, validInput()),
      "unauthenticated",
      "UNAUTHENTICATED",
    );
    assert.equal(calls.where.length, 0);
    assertNoMutationCalls(calls);
  }
});

test("resolves exactly one creator by stored UID and selects only policy-required fields", async () => {
  const { service, calls } = createHarness();
  await service.inviteEmployee(" caller-uid ", validInput());

  assert.deepEqual(calls.where, [["uid", "==", "caller-uid"]]);
  assert.deepEqual(calls.creatorSelect, [["role", "status", "dept"]]);
  assert.deepEqual(calls.creatorLimits, [2]);
  assert.deepEqual(calls.employeeSelect, [["email", "role", "dept"]]);
});

test("does not leak a raw Firestore collection error", async () => {
  const rawMessage = "raw project path and credential details";
  const { service, calls } = createHarness({ collectionError: new Error(rawMessage) });
  const error = await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "internal",
    "EMPLOYEE_COLLECTION_FAILED",
  );
  assert.equal(error.message.includes(rawMessage), false);
  assertNoMutationCalls(calls);
});

test("rejects missing, duplicate, and inactive creator records", async (t) => {
  await t.test("missing", async () => {
    const { service, calls } = createHarness({ creatorDocuments: [] });
    await expectServiceError(
      service.inviteEmployee("caller-uid", validInput()),
      "failed-precondition",
      "CREATOR_NOT_FOUND",
    );
    assertNoMutationCalls(calls);
  });

  await t.test("duplicate", async () => {
    const duplicate = employeeDocument("duplicate-creator", {
      role: "admin",
      status: "active",
      dept: "Management",
    });
    const { service, calls } = createHarness({
      creatorDocuments: [
        employeeDocument("creator-document", {
          role: "admin",
          status: "active",
          dept: "Management",
        }),
        duplicate,
      ],
    });
    await expectServiceError(
      service.inviteEmployee("caller-uid", validInput()),
      "failed-precondition",
      "CREATOR_NOT_UNIQUE",
    );
    assertNoMutationCalls(calls);
  });

  await t.test("inactive", async () => {
    const { service, calls } = createHarness({
      creatorData: {
        uid: "caller-uid",
        role: "admin",
        status: "inactive",
        dept: "Management",
      },
    });
    await expectServiceError(
      service.inviteEmployee("caller-uid", validInput()),
      "permission-denied",
      "CREATOR_INACTIVE",
    );
    assertNoMutationCalls(calls);
  });
});

test("runs the existing policy before Auth or Firestore mutations", async () => {
  const { service, calls } = createHarness({
    creatorData: {
      uid: "caller-uid",
      role: "hr",
      status: "active",
      dept: "Human Resources",
    },
  });
  await expectServiceError(
    service.inviteEmployee("caller-uid", validInput({ role: "admin" })),
    "permission-denied",
    "CREATOR_NOT_AUTHORIZED",
  );
  assert.equal(calls.authEmailLookups.length, 0);
  assertNoMutationCalls(calls);
});

test("protected credential input is rejected by the shared policy before mutation", async () => {
  const { service, calls } = createHarness();
  await expectServiceError(
    service.inviteEmployee("caller-uid", validInput({ password: "must-not-be-used" })),
    "invalid-argument",
    "FORBIDDEN_FIELD",
  );
  assert.equal(calls.authEmailLookups.length, 0);
  assertNoMutationCalls(calls);
});

test("rejects an existing Firebase Auth email before account creation", async () => {
  const { service, calls } = createHarness({ existingAuthUser: { uid: "existing-auth-uid" } });
  await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "already-exists",
    "AUTH_EMAIL_EXISTS",
  );
  assert.deepEqual(calls.authEmailLookups, ["noor.ahmed@example.com"]);
  assertNoMutationCalls(calls);
});

test("atomically creates normalized employee and minimal auth-link records", async () => {
  const { service, calls, firestoreState } = createHarness({
    createdUid: "AuthUid_ABC-123",
  });
  const result = await service.inviteEmployee("caller-uid", validInput());

  assert.deepEqual(calls.authCreates, [{
    email: "noor.ahmed@example.com",
    displayName: "Noor Ahmed",
    disabled: false,
  }]);
  assert.deepEqual(calls.firestoreCollections, ["employees", "authLinks"]);
  assert.deepEqual(calls.firestoreDocs, [
    { collection: "employees", id: "AuthUid_ABC-123" },
    { collection: "authLinks", id: "AuthUid_ABC-123" },
  ]);
  assert.equal(calls.batchCommits, 1);
  assert.deepEqual(calls.batchCreates[0], {
    collection: "employees",
    id: "AuthUid_ABC-123",
    payload: {
      name: "Noor Ahmed",
      email: "noor.ahmed@example.com",
      phone: "+92 300 1234567",
      dept: "Engineering",
      pos: "Software Engineer",
      basic: 120000.5,
      allowances: 15000,
      joinDate: "2026-08-21",
      role: "employee",
      status: "active",
      uid: "AuthUid_ABC-123",
      empId: "EMP-AuthUid_ABC-123",
      createdByUid: "caller-uid",
      createdAt: "2026-08-21T10:30:00.000Z",
      updatedAt: "2026-08-21T10:30:00.000Z",
    },
  });
  assert.deepEqual(calls.batchCreates[1], {
    collection: "authLinks",
    id: "AuthUid_ABC-123",
    payload: {
      employeeId: "AuthUid_ABC-123",
      createdAt: "2026-08-21T10:30:00.000Z",
      updatedAt: "2026-08-21T10:30:00.000Z",
    },
  });
  assert.deepEqual(
    firestoreState.employees.get("AuthUid_ABC-123"),
    calls.batchCreates[0].payload,
  );
  assert.deepEqual(
    firestoreState.authLinks.get("AuthUid_ABC-123"),
    calls.batchCreates[1].payload,
  );
  assert.equal(calls.firestoreCreates.length, 0);
  assert.equal(calls.clock, 1);
  assert.deepEqual(result, {
    employeeDocumentId: "AuthUid_ABC-123",
    empId: "EMP-AuthUid_ABC-123",
    email: "noor.ahmed@example.com",
    requiresPasswordSetup: true,
  });
});

test("disables the Auth account when the sanitized employee is inactive", async () => {
  const { service, calls } = createHarness();
  await service.inviteEmployee("caller-uid", validInput({ status: "INACTIVE" }));
  assert.equal(calls.authCreates[0].disabled, true);
  assert.equal(calls.batchCreates[0].payload.status, "inactive");
  assert.deepEqual(Object.keys(calls.batchCreates[1].payload), [
    "employeeId",
    "createdAt",
    "updatedAt",
  ]);
});

test("uses atomic create-only Firestore semantics and never direct set or update", async () => {
  const { service, calls } = createHarness();
  await service.inviteEmployee("caller-uid", validInput());
  assert.equal(calls.batchCreates.length, 2);
  assert.equal(calls.batchCommits, 1);
  assert.equal(calls.firestoreCreates.length, 0);
  assert.equal(calls.firestoreSets.length, 0);
  assert.equal(calls.firestoreUpdates.length, 0);
});

test("maps Auth creation failures to safe typed errors without Firestore mutation", async () => {
  const rawMessage = "raw credential and token details";
  const { service, calls } = createHarness({
    authCreateError: authError("auth/internal-error", rawMessage),
  });
  const error = await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "internal",
    "AUTH_CREATE_FAILED",
  );
  assert.equal(error.message.includes(rawMessage), false);
  assert.equal(calls.batchCreates.length, 0);
  assert.equal(calls.batchCommits, 0);
  assert.equal(calls.authDeletes.length, 0);
});

test("maps an Auth email race during creation to already-exists", async () => {
  const { service, calls } = createHarness({
    authCreateError: authError("auth/email-already-exists"),
  });
  await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "already-exists",
    "AUTH_EMAIL_EXISTS",
  );
  assert.equal(calls.batchCreates.length, 0);
  assert.equal(calls.batchCommits, 0);
  assert.equal(calls.authDeletes.length, 0);
});

test("an atomic database failure leaves no partial state and rolls back Auth", async () => {
  const rawMessage = "Firestore path and private payload details";
  const { service, calls, firestoreState } = createHarness({
    createdUid: "rollback-auth-uid",
    batchCommitError: new Error(rawMessage),
  });
  const error = await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "internal",
    "EMPLOYEE_CREATE_FAILED",
  );
  assert.equal(error.message.includes(rawMessage), false);
  assert.deepEqual(calls.authDeletes, ["rollback-auth-uid"]);
  assert.equal(calls.batchCreates.length, 2);
  assert.equal(calls.batchCommits, 1);
  assert.equal(firestoreState.employees.size, 0);
  assert.equal(firestoreState.authLinks.size, 0);
  assert.equal(calls.logs.length, 0);
});

test("employee and auth-link conflicts fail atomically and roll back Auth", async (t) => {
  await t.test("employee conflict", async () => {
    const { service, calls, firestoreState } = createHarness({
      createdUid: "employee-conflict-uid",
      employeeConflict: true,
    });
    await expectServiceError(
      service.inviteEmployee("caller-uid", validInput()),
      "internal",
      "EMPLOYEE_CREATE_FAILED",
    );

    assert.deepEqual(calls.authDeletes, ["employee-conflict-uid"]);
    assert.deepEqual(
      firestoreState.employees.get("employee-conflict-uid"),
      { existing: true },
    );
    assert.equal(firestoreState.authLinks.size, 0);
  });

  await t.test("auth-link conflict", async () => {
    const { service, calls, firestoreState } = createHarness({
      createdUid: "auth-link-conflict-uid",
      authLinkConflict: true,
    });
    await expectServiceError(
      service.inviteEmployee("caller-uid", validInput()),
      "internal",
      "EMPLOYEE_CREATE_FAILED",
    );

    assert.deepEqual(calls.authDeletes, ["auth-link-conflict-uid"]);
    assert.equal(firestoreState.employees.size, 0);
    assert.deepEqual(
      firestoreState.authLinks.get("auth-link-conflict-uid"),
      { existing: true },
    );
  });
});

test("preserves the original safe error and logs only a safe event when rollback fails", async () => {
  const sensitiveEmail = "private.person@example.com";
  const sensitiveRollbackMessage = "token=secret profile=private";
  const { service, calls } = createHarness({
    createdUid: "rollback-auth-uid",
    batchCommitError: new Error("raw employee payload"),
    authDeleteError: new Error(sensitiveRollbackMessage),
  });
  const error = await expectServiceError(
    service.inviteEmployee("caller-uid", validInput({ email: sensitiveEmail })),
    "internal",
    "EMPLOYEE_CREATE_FAILED",
  );

  assert.equal(error.message, "Employee invitation could not be completed.");
  assert.deepEqual(calls.authDeletes, ["rollback-auth-uid"]);
  assert.deepEqual(calls.logs, [[
    "Employee invitation Auth rollback failed.",
    { event: "employee_invitation_auth_rollback_failed" },
  ]]);
  const serializedLogs = JSON.stringify(calls.logs);
  assert.equal(serializedLogs.includes(sensitiveEmail), false);
  assert.equal(serializedLogs.includes(sensitiveRollbackMessage), false);
  assert.equal(serializedLogs.includes("rollback-auth-uid"), false);
});

test("logger failure cannot replace the original Firestore service error", async () => {
  const { service } = createHarness({
    batchCommitError: new Error("raw Firestore error"),
    authDeleteError: new Error("raw Auth rollback error"),
    loggerError: new Error("raw logger error"),
  });
  await expectServiceError(
    service.inviteEmployee("caller-uid", validInput()),
    "internal",
    "EMPLOYEE_CREATE_FAILED",
  );
});

test("returns and stores no credential data and keeps auth links strictly minimal", async () => {
  const { service, calls } = createHarness();
  const result = await service.inviteEmployee("caller-uid", validInput());
  const employeePayload = calls.batchCreates[0].payload;
  const authLinkPayload = calls.batchCreates[1].payload;

  assert.deepEqual(Object.keys(result), [
    "employeeDocumentId",
    "empId",
    "email",
    "requiresPasswordSetup",
  ]);
  assert.deepEqual(Object.keys(calls.authCreates[0]), ["email", "displayName", "disabled"]);
  assert.deepEqual(Object.keys(authLinkPayload), ["employeeId", "createdAt", "updatedAt"]);
  assert.equal(authLinkPayload.employeeId, result.employeeDocumentId);
  assert.equal(authLinkPayload.createdAt, employeePayload.createdAt);
  assert.equal(authLinkPayload.updatedAt, employeePayload.updatedAt);
  assertForbiddenCredentialKeys(result);
  assertForbiddenCredentialKeys(calls.authCreates[0]);
  assertForbiddenCredentialKeys(employeePayload);
  assertForbiddenCredentialKeys(authLinkPayload);
  for (const forbiddenField of [
    "role",
    "dept",
    "department",
    "email",
    "status",
    "teamLeadId",
    "profile",
    "token",
    "credential",
    "uid",
  ]) {
    assert.equal(Object.hasOwn(authLinkPayload, forbiddenField), false);
  }
});
