/* global require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AuthSessionVerificationServiceError,
  createAuthSessionVerificationService,
} = require("./authSessionVerificationService");

const FIXED_DATE = new Date("2026-08-21T15:30:00.000Z");
const CALLER_UID = "firebase-auth-uid";
const CALLER_EMAIL = "person@example.com";
const EMPLOYEE_DOCUMENT_ID = "canonical-employee-document";
const AUTH_LINK = Object.freeze({
  employeeId: EMPLOYEE_DOCUMENT_ID,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
});

function validEmployee(overrides = {}) {
  return {
    id: "untrusted-data-id",
    name: "  Person Name  ",
    email: " PERSON@EXAMPLE.COM ",
    phone: " +92 300 1234567 ",
    dept: " Engineering ",
    pos: " Engineer ",
    joinDate: " 2026-01-15 ",
    empId: " EMP-1001 ",
    role: "employee",
    status: " ACTIVE ",
    uid: CALLER_UID,
    basic: 150000,
    salary: 180000,
    allowances: 30000,
    password: "must-not-leak",
    pass: "must-not-leak",
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    createdByUid: "creator-secret-uid",
    teamLeadId: "private-team-link",
    token: "secret-token",
    credentials: { secret: true },
    ...overrides,
  };
}

function createHarness(options = {}) {
  const calls = {
    collections: [],
    documents: [],
    reads: [],
    legacyLinks: [],
    logs: [],
    clock: 0,
  };
  const state = {
    authLinks: new Map(),
    employees: new Map(),
  };

  if (options.authLink !== null) {
    state.authLinks.set(CALLER_UID, options.authLink || { ...AUTH_LINK });
  }
  if (options.employee !== null) {
    state.employees.set(
      options.employeeDocumentId || EMPLOYEE_DOCUMENT_ID,
      options.employee || validEmployee(),
    );
  }

  const firestore = {
    collection(name) {
      calls.collections.push(name);
      if (options.collectionError) throw options.collectionError;
      if (!Object.prototype.hasOwnProperty.call(state, name)) {
        throw new Error("unexpected collection");
      }
      return {
        doc(id) {
          calls.documents.push({ collection: name, id });
          if (options.documentReferenceError) throw options.documentReferenceError;
          return {
            async get() {
              calls.reads.push({ collection: name, id });
              const configuredError = name === "authLinks"
                ? options.authLinkReadError
                : options.employeeReadError;
              if (configuredError) throw configuredError;
              if (options.invalidSnapshotCollection === name) return {};
              const exists = state[name].has(id);
              return {
                exists,
                data: () => state[name].get(id),
              };
            },
          };
        },
      };
    },
  };

  const legacyLinkOperation = async function legacyLinkOperation(uid, email) {
    calls.legacyLinks.push({ uid, email, argumentsLength: arguments.length });
    if (options.legacyError) throw options.legacyError;
    if (options.legacyBehavior) {
      return options.legacyBehavior({ uid, email, state, calls });
    }

    state.authLinks.set(uid, { ...AUTH_LINK });
    return {
      employeeDocumentId: EMPLOYEE_DOCUMENT_ID,
      linked: true,
      alreadyLinked: true,
    };
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

  const service = createAuthSessionVerificationService({
    firestore,
    legacyLinkOperation,
    logger,
    clock,
  });
  return { service, calls, state };
}

async function expectServiceError(promise, code, reason, message) {
  let received;
  try {
    await promise;
  } catch (error) {
    received = error;
  }

  assert.ok(received instanceof AuthSessionVerificationServiceError);
  assert.equal(received.name, "AuthSessionVerificationServiceError");
  assert.equal(received.code, code);
  assert.equal(received.reason, reason);
  if (message) assert.equal(received.message, message);
  assert.equal(typeof received.message, "string");
  assert.ok(received.message.length > 0);
  return received;
}

function assertNoIdentityLeak(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    CALLER_UID,
    CALLER_EMAIL,
    "must-not-leak",
    "secret-token",
    "creator-secret-uid",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked identity data: ${forbidden}`);
  }
}

test("verifies an existing auth link and returns the exact UI-safe principal shape", async () => {
  const { service, calls } = createHarness();
  const result = await service.verifyAuthSession(
    ` ${CALLER_UID} `,
    " PERSON@EXAMPLE.COM ",
    "employee",
  );

  assert.deepEqual(result, {
    employee: {
      id: EMPLOYEE_DOCUMENT_ID,
      name: "Person Name",
      email: CALLER_EMAIL,
      phone: "+92 300 1234567",
      dept: "Engineering",
      pos: "Engineer",
      joinDate: "2026-01-15",
      empId: "EMP-1001",
      role: "employee",
    },
    linkage: "uid",
  });
  assert.deepEqual(Object.keys(result), ["employee", "linkage"]);
  assert.deepEqual(Object.keys(result.employee), [
    "id",
    "name",
    "email",
    "phone",
    "dept",
    "pos",
    "joinDate",
    "empId",
    "role",
  ]);
  assert.equal(result.employee.id, EMPLOYEE_DOCUMENT_ID);
  assert.equal(calls.legacyLinks.length, 0);
  assert.deepEqual(calls.reads, [
    { collection: "authLinks", id: CALLER_UID },
    { collection: "employees", id: EMPLOYEE_DOCUMENT_ID },
  ]);
  assert.equal(calls.logs.length, 0);
  assert.equal(calls.clock, 0);
});

test("never returns sensitive employee, authentication, or internal metadata", async () => {
  const { service } = createHarness();
  const result = await service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee");
  const forbiddenKeys = [
    "uid",
    "status",
    "basic",
    "salary",
    "allowances",
    "password",
    "pass",
    "createdAt",
    "updatedAt",
    "createdByUid",
    "teamLeadId",
    "token",
    "credentials",
  ];

  for (const key of forbiddenKeys) {
    assert.equal(Object.prototype.hasOwnProperty.call(result.employee, key), false, key);
  }
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("supports each exact application role and rejects role normalization shortcuts", async (t) => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    await t.test(role, async () => {
      const { service } = createHarness({ employee: validEmployee({ role }) });
      const result = await service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, role);
      assert.equal(result.employee.role, role);
    });
  }

  for (const selectedRole of [null, undefined, "", "Admin", "team-lead", " employee ", 1]) {
    const { service, calls } = createHarness();
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, selectedRole),
      "invalid-argument",
      "INVALID_SELECTED_ROLE",
    );
    assert.equal(calls.reads.length, 0);
    assert.equal(calls.legacyLinks.length, 0);
  }
});

test("rejects invalid authenticated UID or token email before Firestore access", async () => {
  const invalidIdentities = [
    [null, CALLER_EMAIL],
    ["", CALLER_EMAIL],
    ["uid with space", CALLER_EMAIL],
    ["x".repeat(129), CALLER_EMAIL],
    [CALLER_UID, null],
    [CALLER_UID, ""],
    [CALLER_UID, "not-an-email"],
  ];

  for (const [uid, email] of invalidIdentities) {
    const { service, calls } = createHarness();
    await expectServiceError(
      service.verifyAuthSession(uid, email, "employee"),
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
    );
    assert.equal(calls.reads.length, 0);
    assert.equal(calls.legacyLinks.length, 0);
  }
});

test("repairs a missing auth link for an already UID-linked employee and re-reads it", async () => {
  const { service, calls, state } = createHarness({
    authLink: null,
    legacyBehavior({ uid, state: mutableState }) {
      mutableState.authLinks.set(uid, { ...AUTH_LINK });
      return {
        employeeDocumentId: EMPLOYEE_DOCUMENT_ID,
        linked: true,
        alreadyLinked: true,
      };
    },
  });

  const result = await service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee");
  assert.equal(result.linkage, "uid");
  assert.deepEqual(calls.legacyLinks, [{
    uid: CALLER_UID,
    email: CALLER_EMAIL,
    argumentsLength: 2,
  }]);
  assert.equal(calls.reads.filter(({ collection }) => collection === "authLinks").length, 2);
  assert.equal(state.authLinks.get(CALLER_UID).employeeId, EMPLOYEE_DOCUMENT_ID);
});

test("repairs a legacy email employee link before verification", async () => {
  const legacyDocumentId = "legacy-employee-document";
  const { service, calls, state } = createHarness({
    authLink: null,
    employee: null,
    legacyBehavior({ uid, state: mutableState }) {
      mutableState.employees.set(legacyDocumentId, validEmployee({ uid }));
      mutableState.authLinks.set(uid, {
        employeeId: legacyDocumentId,
        createdAt: FIXED_DATE.toISOString(),
        updatedAt: FIXED_DATE.toISOString(),
      });
      return {
        employeeDocumentId: legacyDocumentId,
        linked: true,
        alreadyLinked: false,
      };
    },
  });

  const result = await service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee");
  assert.equal(result.employee.id, legacyDocumentId);
  assert.equal(result.linkage, "uid");
  assert.equal(calls.legacyLinks.length, 1);
  assert.equal(state.employees.get(legacyDocumentId).uid, CALLER_UID);
});

test("rejects missing, malformed, and conflicting auth-link repair outcomes", async (t) => {
  await t.test("repair reports success without creating the link", async () => {
    const { service } = createHarness({
      authLink: null,
      legacyBehavior() {
        return {
          employeeDocumentId: EMPLOYEE_DOCUMENT_ID,
          linked: true,
          alreadyLinked: true,
        };
      },
    });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "AUTH_LINK_MISSING",
    );
  });

  await t.test("repair returns an invalid result", async () => {
    const { service } = createHarness({
      authLink: null,
      legacyBehavior() {
        return { employeeDocumentId: EMPLOYEE_DOCUMENT_ID, linked: false };
      },
    });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
    );
  });

  await t.test("repair result conflicts with the persisted link", async () => {
    const { service } = createHarness({
      authLink: null,
      legacyBehavior({ uid, state }) {
        state.authLinks.set(uid, { ...AUTH_LINK });
        return {
          employeeDocumentId: "different-employee-document",
          linked: true,
        };
      },
    });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
    );
  });
});

test("rejects malformed or privileged auth-link documents as conflicts", async () => {
  const invalidLinks = [
    {},
    { ...AUTH_LINK, employeeId: "" },
    { ...AUTH_LINK, employeeId: "other/path" },
    { ...AUTH_LINK, createdAt: "not-a-date" },
    { ...AUTH_LINK, email: CALLER_EMAIL },
  ];

  for (const authLink of invalidLinks) {
    const { service, calls } = createHarness({ authLink });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
    );
    assert.equal(calls.legacyLinks.length, 0);
  }
});

test("maps safe legacy-link validation failures without exposing raw details", async (t) => {
  const cases = [
    ["EMPLOYEE_NOT_FOUND", "not-found", "EMPLOYEE_NOT_FOUND"],
    ["EMPLOYEE_INACTIVE", "failed-precondition", "EMPLOYEE_INACTIVE"],
    ["UID_EMAIL_MISMATCH", "failed-precondition", "EMAIL_MISMATCH"],
    ["DUPLICATE_UID_LINK", "failed-precondition", "AUTH_LINK_CONFLICT"],
    ["DUPLICATE_EMAIL_LINK", "failed-precondition", "AUTH_LINK_CONFLICT"],
    ["UID_LINK_CONFLICT", "failed-precondition", "AUTH_LINK_CONFLICT"],
  ];

  for (const [legacyReason, code, reason] of cases) {
    await t.test(legacyReason, async () => {
      const rawError = new Error(`raw ${CALLER_EMAIL} token=secret`);
      rawError.reason = legacyReason;
      const { service } = createHarness({ authLink: null, legacyError: rawError });
      const error = await expectServiceError(
        service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
        code,
        reason,
      );
      assert.equal(error.message.includes(CALLER_EMAIL), false);
      assert.equal(error.message.includes("secret"), false);
    });
  }
});

test("rejects a missing canonical employee", async () => {
  const { service } = createHarness({ employee: null });
  await expectServiceError(
    service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
    "not-found",
    "EMPLOYEE_NOT_FOUND",
  );
});

test("rejects inactive employees case-insensitively", async () => {
  for (const status of ["inactive", " INACTIVE ", "suspended", "", null]) {
    const { service } = createHarness({ employee: validEmployee({ status }) });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "EMPLOYEE_INACTIVE",
    );
  }
});

test("rejects employee UID and authenticated email mismatches", async (t) => {
  await t.test("UID mismatch", async () => {
    const { service } = createHarness({ employee: validEmployee({ uid: "different-uid" }) });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "UID_MISMATCH",
    );
  });

  await t.test("email mismatch", async () => {
    const { service } = createHarness({
      employee: validEmployee({ email: "different@example.com" }),
    });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "EMAIL_MISMATCH",
    );
  });
});

test("rejects a selected-role mismatch with the exact existing message", async () => {
  const { service } = createHarness({ employee: validEmployee({ role: "manager" }) });
  await expectServiceError(
    service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
    "permission-denied",
    "ROLE_MISMATCH",
    "These credentials do not belong to the selected role.",
  );
});

test("rejects malformed employee data as a typed data-integrity failure", async (t) => {
  await t.test("non-object data", async () => {
    const { service } = createHarness({ employee: "invalid" });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "DATA_INTEGRITY_FAILURE",
    );
  });

  await t.test("unsupported stored role", async () => {
    const { service } = createHarness({ employee: validEmployee({ role: "owner" }) });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "failed-precondition",
      "DATA_INTEGRITY_FAILURE",
    );
  });
});

test("maps Firestore and legacy operation failures to safe internal errors and logs no identity", async (t) => {
  await t.test("Firestore read", async () => {
    const rawMessage = `${CALLER_UID} ${CALLER_EMAIL} token=secret`;
    const { service, calls } = createHarness({
      authLinkReadError: new Error(rawMessage),
    });
    const error = await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "internal",
      "AUTH_LINK_READ_FAILED",
    );
    assert.equal(error.message.includes(rawMessage), false);
    assert.equal(calls.logs.length, 1);
    assert.deepEqual(calls.logs[0], [
      "Employee session verification failed.",
      {
        event: "auth_session_verification_failed",
        reason: "AUTH_LINK_READ_FAILED",
        occurredAt: FIXED_DATE.toISOString(),
      },
    ]);
    assertNoIdentityLeak(calls.logs);
  });

  await t.test("legacy operation", async () => {
    const { service, calls } = createHarness({
      authLink: null,
      legacyError: new Error(`raw ${CALLER_EMAIL} token=secret`),
    });
    await expectServiceError(
      service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
      "internal",
      "LEGACY_LINK_FAILED",
    );
    assert.equal(calls.logs.length, 1);
    assertNoIdentityLeak(calls.logs);
  });
});

test("logger or clock failures cannot replace a safe internal verification error", async () => {
  const { service } = createHarness({
    employeeReadError: new Error("raw Firestore credentials"),
    loggerError: new Error("raw logger failure"),
    clockError: new Error("raw clock failure"),
  });
  await expectServiceError(
    service.verifyAuthSession(CALLER_UID, CALLER_EMAIL, "employee"),
    "internal",
    "EMPLOYEE_READ_FAILED",
  );
});

test("rejects invalid service dependencies synchronously", () => {
  const valid = createHarness();
  const dependencies = {
    firestore: { collection() {} },
    legacyLinkOperation() {},
    logger: { error() {} },
    clock: () => FIXED_DATE,
  };

  for (const key of Object.keys(dependencies)) {
    const invalid = { ...dependencies, [key]: null };
    assert.throws(
      () => createAuthSessionVerificationService(invalid),
      (error) => error instanceof AuthSessionVerificationServiceError
        && error.reason === "INVALID_SERVICE_CONFIGURATION",
    );
  }
  assert.ok(valid.service);
});
