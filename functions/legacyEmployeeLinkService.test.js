/* global require */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LegacyEmployeeLinkServiceError,
  createLegacyEmployeeLinkService,
} = require("./legacyEmployeeLinkService");

const FIXED_DATE = new Date("2026-08-21T12:00:00.000Z");
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function employeeDocument(id, data) {
  return {
    id,
    data: () => ({ ...data }),
  };
}

function querySnapshot(documents) {
  return { docs: documents };
}

function documentSnapshot(data, exists = true) {
  return {
    exists,
    data: () => ({ ...data }),
  };
}

function createHarness(options = {}) {
  const calls = {
    collections: [],
    where: [],
    select: [],
    limits: [],
    documents: [],
    transactions: 0,
    transactionGets: [],
    transactionUpdates: [],
    transactionCreates: [],
    logs: [],
    clock: 0,
  };

  const legacyData = own(options, "legacyData") ? options.legacyData : {
    email: "person@example.com",
    status: "active",
    uid: "",
    role: "employee",
    dept: "Engineering",
    empId: "EMP-LEGACY",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
  const uidDocuments = own(options, "uidDocuments") ? options.uidDocuments : [];
  const emailDocuments = own(options, "emailDocuments")
    ? options.emailDocuments
    : [employeeDocument("employee-document", legacyData)];
  const transactionEmployeeId = uidDocuments.length === 1
    ? uidDocuments[0].id
    : emailDocuments[0]?.id || "employee-document";
  const defaultLatestData = uidDocuments.length === 1
    ? uidDocuments[0].data()
    : legacyData;
  const latestData = own(options, "latestData") ? options.latestData : defaultLatestData;
  const firestoreState = {
    employees: new Map(),
    authLinks: new Map(),
  };
  if (options.transactionExists !== false) {
    firestoreState.employees.set(transactionEmployeeId, { ...latestData });
  }
  if (own(options, "authLinkData")) {
    firestoreState.authLinks.set("caller-uid", { ...options.authLinkData });
  }

  const documentReference = (collection, id) => {
    calls.documents.push({ collection, id });
    if (options.documentReferenceError) throw options.documentReferenceError;
    return { collection, id };
  };

  const employeesCollection = {
    where(field, operator, value) {
      calls.where.push([field, operator, value]);
      const lookupType = field === "uid" ? "uid" : "email";
      return {
        select(...fields) {
          calls.select.push({ lookupType, fields });
          return this;
        },
        limit(valueToLimit) {
          calls.limits.push({ lookupType, value: valueToLimit });
          return this;
        },
        async get() {
          const lookupError = lookupType === "uid"
            ? options.uidLookupError
            : options.emailLookupError;
          if (lookupError) throw lookupError;
          return querySnapshot(lookupType === "uid" ? uidDocuments : emailDocuments);
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
      calls.collections.push(name);
      if (options.collectionError) throw options.collectionError;
      if (name === "employees") return employeesCollection;
      if (name === "authLinks") {
        if (options.authLinkCollectionError) throw options.authLinkCollectionError;
        return authLinksCollection;
      }
      throw new Error("unexpected collection");
    },
    async runTransaction(callback) {
      calls.transactions += 1;
      if (options.runTransactionError) throw options.runTransactionError;

      const stagedUpdates = [];
      const stagedCreates = [];

      const transaction = {
        async get(reference) {
          calls.transactionGets.push({
            collection: reference.collection,
            id: reference.id,
          });
          if (options.transactionReadError) throw options.transactionReadError;
          const data = firestoreState[reference.collection].get(reference.id);
          return documentSnapshot(data, data !== undefined);
        },
        update(reference, updates) {
          const operation = {
            collection: reference.collection,
            id: reference.id,
            updates: { ...updates },
          };
          calls.transactionUpdates.push(operation);
          if (options.transactionUpdateError) throw options.transactionUpdateError;
          stagedUpdates.push(operation);
        },
        create(reference, data) {
          const operation = {
            collection: reference.collection,
            id: reference.id,
            data: { ...data },
          };
          calls.transactionCreates.push(operation);
          if (options.transactionCreateError) throw options.transactionCreateError;
          stagedCreates.push(operation);
        },
      };
      const result = await callback(transaction);
      if (own(options, "concurrentAuthLinkData")) {
        firestoreState.authLinks.set("caller-uid", { ...options.concurrentAuthLinkData });
      }
      if (options.transactionCommitError) throw options.transactionCommitError;

      for (const { collection, id } of stagedCreates) {
        if (firestoreState[collection].has(id)) {
          throw new Error("create-only conflict");
        }
      }
      for (const { collection, id } of stagedUpdates) {
        if (!firestoreState[collection].has(id)) {
          throw new Error("update target missing");
        }
      }
      for (const { collection, id, updates } of stagedUpdates) {
        firestoreState[collection].set(id, {
          ...firestoreState[collection].get(id),
          ...updates,
        });
      }
      for (const { collection, id, data } of stagedCreates) {
        firestoreState[collection].set(id, { ...data });
      }
      return result;
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
    return own(options, "clockValue") ? options.clockValue : FIXED_DATE;
  };

  const service = createLegacyEmployeeLinkService({ firestore, logger, clock });
  return { service, calls, firestoreState };
}

async function expectServiceError(promise, code, reason) {
  let received;
  try {
    await promise;
  } catch (error) {
    received = error;
  }

  assert.ok(received instanceof LegacyEmployeeLinkServiceError);
  assert.equal(received.name, "LegacyEmployeeLinkServiceError");
  assert.equal(received.code, code);
  assert.equal(received.reason, reason);
  assert.equal(typeof received.message, "string");
  assert.ok(received.message.length > 0);
  return received;
}

function assertNoWrites(calls) {
  assert.equal(calls.transactions, 0);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 0);
}

function assertSafeResult(result) {
  assert.deepEqual(Object.keys(result), [
    "employeeDocumentId",
    "linked",
    "alreadyLinked",
  ]);
  for (const forbiddenKey of [
    "email",
    "role",
    "profile",
    "token",
    "credential",
    "uid",
    "status",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, forbiddenKey), false);
  }
}

function assertMinimalAuthLink(authLink, employeeId, timestamp) {
  assert.deepEqual(Object.keys(authLink), ["employeeId", "createdAt", "updatedAt"]);
  assert.deepEqual(authLink, {
    employeeId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const forbiddenKey of [
    "email",
    "role",
    "dept",
    "department",
    "status",
    "teamLeadId",
    "profile",
    "token",
    "credential",
    "uid",
  ]) {
    assert.equal(own(authLink, forbiddenKey), false);
  }
}

test("rejects malformed caller UIDs and emails before Firestore access", async (t) => {
  await t.test("invalid UID", async () => {
    for (const uid of [null, undefined, "", "   ", "bad uid", "x".repeat(129)]) {
      const { service, calls } = createHarness();
      await expectServiceError(
        service.linkLegacyEmployee(uid, "person@example.com"),
        "unauthenticated",
        "INVALID_AUTH_IDENTITY",
      );
      assert.equal(calls.collections.length, 0);
      assertNoWrites(calls);
    }
  });

  await t.test("invalid email", async () => {
    for (const email of [null, undefined, "", "   ", "not-an-email", "a@b"] ) {
      const { service, calls } = createHarness();
      await expectServiceError(
        service.linkLegacyEmployee("caller-uid", email),
        "unauthenticated",
        "INVALID_AUTH_IDENTITY",
      );
      assert.equal(calls.collections.length, 0);
      assertNoWrites(calls);
    }
  });
});

test("normalizes identity and reports a missing employee safely", async () => {
  const { service, calls } = createHarness({ emailDocuments: [] });
  await expectServiceError(
    service.linkLegacyEmployee("  caller-uid  ", "  PERSON@EXAMPLE.COM "),
    "failed-precondition",
    "EMPLOYEE_NOT_FOUND",
  );

  assert.deepEqual(calls.collections, ["employees"]);
  assert.deepEqual(calls.where, [
    ["uid", "==", "caller-uid"],
    ["email", "==", "person@example.com"],
  ]);
  assert.deepEqual(calls.limits, [
    { lookupType: "uid", value: 2 },
    { lookupType: "email", value: 2 },
  ]);
  assertNoWrites(calls);
});

test("rejects duplicate UID-linked employee records", async () => {
  const { service, calls } = createHarness({
    uidDocuments: [
      employeeDocument("employee-one", { email: "person@example.com", uid: "caller-uid" }),
      employeeDocument("employee-two", { email: "person@example.com", uid: "caller-uid" }),
    ],
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "DUPLICATE_UID_LINK",
  );
  assert.equal(calls.where.length, 1);
  assertNoWrites(calls);
});

test("rejects duplicate legacy email records", async () => {
  const { service, calls } = createHarness({
    emailDocuments: [
      employeeDocument("employee-one", { email: "person@example.com", status: "active" }),
      employeeDocument("employee-two", { email: "person@example.com", status: "active" }),
    ],
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "DUPLICATE_EMAIL_LINK",
  );
  assertNoWrites(calls);
});

test("rejects inactive legacy employees before opening a transaction", async () => {
  const { service, calls } = createHarness({
    legacyData: { email: "person@example.com", status: " InActive ", uid: "" },
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "permission-denied",
    "EMPLOYEE_INACTIVE",
  );
  assertNoWrites(calls);
});

test("rejects legacy employees that already contain a conflicting UID", async () => {
  for (const conflictingUid of ["another-uid", 12345]) {
    const { service, calls } = createHarness({
      legacyData: {
        email: "person@example.com",
        status: "active",
        uid: conflictingUid,
      },
    });
    await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "failed-precondition",
      "UID_LINK_CONFLICT",
    );
    assertNoWrites(calls);
  }
});

test("atomically links the employee and creates an exact minimal auth-link", async () => {
  const profile = {
    email: "person@example.com",
    status: "ACTIVE",
    uid: null,
    name: "Private Person",
    role: "employee",
    dept: "Engineering",
    teamLeadId: "team-lead-document",
    empId: "EMP-LEGACY",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
  const { service, calls, firestoreState } = createHarness({
    legacyData: profile,
    latestData: profile,
  });
  const result = await service.linkLegacyEmployee(
    " caller-uid ",
    " PERSON@EXAMPLE.COM ",
  );

  assert.deepEqual(result, {
    employeeDocumentId: "employee-document",
    linked: true,
    alreadyLinked: false,
  });
  assertSafeResult(result);
  assert.equal(calls.transactions, 1);
  assert.deepEqual(calls.transactionGets, [
    { collection: "employees", id: "employee-document" },
    { collection: "authLinks", id: "caller-uid" },
  ]);
  assert.deepEqual(calls.transactionUpdates, [{
    collection: "employees",
    id: "employee-document",
    updates: {
      uid: "caller-uid",
      updatedAt: "2026-08-21T12:00:00.000Z",
    },
  }]);
  assert.equal(calls.transactionCreates.length, 1);
  assert.deepEqual(calls.transactionCreates[0], {
    collection: "authLinks",
    id: "caller-uid",
    data: {
      employeeId: "employee-document",
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z",
    },
  });
  assert.deepEqual(firestoreState.employees.get("employee-document"), {
    ...profile,
    uid: "caller-uid",
    updatedAt: "2026-08-21T12:00:00.000Z",
  });
  assertMinimalAuthLink(
    firestoreState.authLinks.get("caller-uid"),
    "employee-document",
    "2026-08-21T12:00:00.000Z",
  );
  assert.equal(calls.clock, 1);
});

test("rejects a concurrent UID-link conflict after transaction re-read", async () => {
  const { service, calls } = createHarness({
    latestData: {
      email: "person@example.com",
      status: "active",
      uid: "concurrent-other-uid",
    },
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "UID_LINK_CONFLICT",
  );
  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 0);
});

test("rejects a conflicting auth-link before updating an unlinked employee", async () => {
  const conflictingAuthLink = {
    employeeId: "different-employee",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const { service, calls, firestoreState } = createHarness({
    authLinkData: conflictingAuthLink,
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "UID_LINK_CONFLICT",
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 0);
  assert.equal(firestoreState.employees.get("employee-document").uid, "");
  assert.deepEqual(firestoreState.authLinks.get("caller-uid"), conflictingAuthLink);
});

test("an already-linked employee atomically receives a missing auth-link", async () => {
  const { service, calls, firestoreState } = createHarness({
    uidDocuments: [employeeDocument("linked-document", {
      email: " PERSON@EXAMPLE.COM ",
      uid: "caller-uid",
      role: "employee",
    })],
  });
  const result = await service.linkLegacyEmployee("caller-uid", "person@example.com");

  assert.deepEqual(result, {
    employeeDocumentId: "linked-document",
    linked: true,
    alreadyLinked: true,
  });
  assertSafeResult(result);
  assert.equal(calls.where.length, 1);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 1);
  assertMinimalAuthLink(
    calls.transactionCreates[0].data,
    "linked-document",
    "2026-08-21T12:00:00.000Z",
  );
  assertMinimalAuthLink(
    firestoreState.authLinks.get("caller-uid"),
    "linked-document",
    "2026-08-21T12:00:00.000Z",
  );
  assert.equal(calls.clock, 1);
});

test("an already-linked employee accepts a matching auth-link without overwriting it", async () => {
  const existingAuthLink = {
    employeeId: "linked-document",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-02-01T00:00:00.000Z",
  };
  const { service, calls, firestoreState } = createHarness({
    uidDocuments: [employeeDocument("linked-document", {
      email: "person@example.com",
      uid: "caller-uid",
    })],
    authLinkData: existingAuthLink,
  });
  const result = await service.linkLegacyEmployee("caller-uid", "person@example.com");

  assert.deepEqual(result, {
    employeeDocumentId: "linked-document",
    linked: true,
    alreadyLinked: true,
  });
  assertSafeResult(result);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 0);
  assert.equal(calls.clock, 0);
  assert.deepEqual(firestoreState.authLinks.get("caller-uid"), existingAuthLink);
});

test("an already-linked employee rejects a conflicting auth-link without writes", async () => {
  const { service, calls, firestoreState } = createHarness({
    uidDocuments: [employeeDocument("linked-document", {
      email: "person@example.com",
      uid: "caller-uid",
    })],
    authLinkData: {
      employeeId: "different-employee",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "UID_LINK_CONFLICT",
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 0);
  assert.equal(calls.clock, 0);
  assert.equal(firestoreState.employees.get("linked-document").uid, "caller-uid");
  assert.equal(
    firestoreState.authLinks.get("caller-uid").employeeId,
    "different-employee",
  );
});

test("rejects an email mismatch on an existing UID link without fallback", async () => {
  const { service, calls } = createHarness({
    uidDocuments: [employeeDocument("linked-document", {
      email: "different@example.com",
      uid: "caller-uid",
    })],
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "failed-precondition",
    "UID_EMAIL_MISMATCH",
  );
  assert.equal(calls.where.length, 1);
  assertNoWrites(calls);
});

test("a same-UID concurrent employee link creates only the missing auth-link", async () => {
  const { service, calls, firestoreState } = createHarness({
    latestData: {
      email: "person@example.com",
      status: "active",
      uid: "caller-uid",
    },
  });
  const result = await service.linkLegacyEmployee("caller-uid", "person@example.com");

  assert.deepEqual(result, {
    employeeDocumentId: "employee-document",
    linked: true,
    alreadyLinked: true,
  });
  assertSafeResult(result);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.transactionUpdates.length, 0);
  assert.equal(calls.transactionCreates.length, 1);
  assertMinimalAuthLink(
    firestoreState.authLinks.get("caller-uid"),
    "employee-document",
    "2026-08-21T12:00:00.000Z",
  );
});

test("rechecks email, active status, and document existence inside the transaction", async (t) => {
  await t.test("email changed", async () => {
    const { service, calls } = createHarness({
      latestData: { email: "changed@example.com", status: "active", uid: "" },
    });
    await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "failed-precondition",
      "UID_EMAIL_MISMATCH",
    );
    assert.equal(calls.transactionUpdates.length, 0);
  });

  await t.test("status changed", async () => {
    const { service, calls } = createHarness({
      latestData: { email: "person@example.com", status: "inactive", uid: "" },
    });
    await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "permission-denied",
      "EMPLOYEE_INACTIVE",
    );
    assert.equal(calls.transactionUpdates.length, 0);
  });

  await t.test("document deleted", async () => {
    const { service, calls } = createHarness({ transactionExists: false });
    await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "failed-precondition",
      "EMPLOYEE_LINK_TARGET_MISSING",
    );
    assert.equal(calls.transactionUpdates.length, 0);
  });
});

test("maps transaction write failures to a safe error and safe structured log", async () => {
  const rawMessage = "uid=caller-uid email=person@example.com token=secret";
  const { service, calls, firestoreState } = createHarness({
    transactionCommitError: new Error(rawMessage),
  });
  const error = await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "internal",
    "LINK_TRANSACTION_FAILED",
  );

  assert.equal(error.message.includes(rawMessage), false);
  assert.deepEqual(calls.logs, [[
    "Legacy employee UID link transaction failed.",
    { event: "legacy_employee_uid_link_transaction_failed" },
  ]]);
  const serializedLogs = JSON.stringify(calls.logs);
  assert.equal(serializedLogs.includes("caller-uid"), false);
  assert.equal(serializedLogs.includes("person@example.com"), false);
  assert.equal(serializedLogs.includes("secret"), false);
  assert.equal(firestoreState.employees.get("employee-document").uid, "");
  assert.equal(firestoreState.authLinks.size, 0);
});

test("a concurrent auth-link create conflict leaves the employee unchanged", async () => {
  const concurrentAuthLink = {
    employeeId: "different-employee",
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
  };
  const { service, calls, firestoreState } = createHarness({
    concurrentAuthLinkData: concurrentAuthLink,
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "internal",
    "LINK_TRANSACTION_FAILED",
  );

  assert.equal(calls.transactionUpdates.length, 1);
  assert.equal(calls.transactionCreates.length, 1);
  assert.equal(firestoreState.employees.get("employee-document").uid, "");
  assert.deepEqual(firestoreState.authLinks.get("caller-uid"), concurrentAuthLink);
});

test("logger failure cannot replace the safe transaction error", async () => {
  const { service } = createHarness({
    transactionCommitError: new Error("raw Firestore credentials"),
    loggerError: new Error("raw logging failure"),
  });
  await expectServiceError(
    service.linkLegacyEmployee("caller-uid", "person@example.com"),
    "internal",
    "LINK_TRANSACTION_FAILED",
  );
});

test("maps raw lookup and clock failures without exposing SDK details", async (t) => {
  await t.test("UID lookup", async () => {
    const rawMessage = "private Firestore project and credentials";
    const { service, calls } = createHarness({ uidLookupError: new Error(rawMessage) });
    const error = await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "internal",
      "UID_LOOKUP_FAILED",
    );
    assert.equal(error.message.includes(rawMessage), false);
    assertNoWrites(calls);
  });

  await t.test("clock", async () => {
    const { service, calls } = createHarness({ clockValue: "invalid-date" });
    await expectServiceError(
      service.linkLegacyEmployee("caller-uid", "person@example.com"),
      "internal",
      "CLOCK_FAILED",
    );
    assert.equal(calls.transactions, 1);
    assert.equal(calls.transactionUpdates.length, 0);
    assert.equal(calls.transactionCreates.length, 0);
  });
});
