/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UID_LOOKUP_FIELDS = ["email", "uid"];
const EMAIL_LOOKUP_FIELDS = ["email", "status", "uid"];
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];
const INVALID_EMPLOYEE_UID = Symbol("invalid-employee-uid");

class LegacyEmployeeLinkServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "LegacyEmployeeLinkServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new LegacyEmployeeLinkServiceError(code, reason, message);
}

function assertDependencies(firestore, logger, clock) {
  const validFirestore = firestore
    && typeof firestore.collection === "function"
    && typeof firestore.runTransaction === "function";
  const validLogger = logger && typeof logger.error === "function";

  if (!validFirestore || !validLogger || typeof clock !== "function") {
    throw serviceError(
      "failed-precondition",
      "INVALID_SERVICE_CONFIGURATION",
      "Employee account linking service is not configured.",
    );
  }
}

function hasInvalidUidCharacters(uid) {
  return [...uid].some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
  });
}

function normalizeCallerUid(callerUid) {
  const uid = typeof callerUid === "string" ? callerUid.trim() : "";
  if (!uid || uid.length > MAX_FIREBASE_UID_LENGTH || hasInvalidUidCharacters(uid)) {
    throw serviceError(
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
      "A valid authenticated identity is required.",
    );
  }
  return uid;
}

function normalizeCallerEmail(callerEmail) {
  const email = typeof callerEmail === "string" ? callerEmail.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw serviceError(
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
      "A valid authenticated identity is required.",
    );
  }
  return email;
}

function employeeCollection(firestore) {
  try {
    return firestore.collection("employees");
  } catch {
    throw serviceError(
      "internal",
      "EMPLOYEE_COLLECTION_FAILED",
      "Employee account could not be linked.",
    );
  }
}

function snapshotDocuments(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.docs)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }
  return snapshot.docs;
}

function employeeDocument(document) {
  if (!document || typeof document.id !== "string" || typeof document.data !== "function") {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }

  const data = document.data();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }
  return { documentId: document.id, data };
}

function normalizedEmployeeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function normalizedEmployeeUid(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID_EMPLOYEE_UID;
  const uid = value.trim();
  return uid || null;
}

function assertMatchingEmail(data, callerEmail) {
  if (normalizedEmployeeEmail(data.email) !== callerEmail) {
    throw serviceError(
      "failed-precondition",
      "UID_EMAIL_MISMATCH",
      "The authentication account does not match its employee profile.",
    );
  }
}

function assertActiveEmployee(data) {
  if (typeof data.status !== "string" || data.status.trim().toLowerCase() !== "active") {
    throw serviceError(
      "permission-denied",
      "EMPLOYEE_INACTIVE",
      "The employee account is inactive.",
    );
  }
}

function idempotentResult(documentId) {
  return {
    employeeDocumentId: documentId,
    linked: true,
    alreadyLinked: true,
  };
}

function linkedResult(documentId) {
  return {
    employeeDocumentId: documentId,
    linked: true,
    alreadyLinked: false,
  };
}

async function queryEmployees(collection, field, value, selectedFields, failureReason) {
  try {
    const snapshot = await collection
      .where(field, "==", value)
      .select(...selectedFields)
      .limit(2)
      .get();
    return snapshotDocuments(snapshot);
  } catch (error) {
    if (error instanceof LegacyEmployeeLinkServiceError) throw error;
    throw serviceError(
      "internal",
      failureReason,
      "Employee account could not be linked.",
    );
  }
}

function currentTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw serviceError(
      "internal",
      "CLOCK_FAILED",
      "Employee account could not be linked.",
    );
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError(
      "internal",
      "CLOCK_FAILED",
      "Employee account could not be linked.",
    );
  }
  return date.toISOString();
}

function safeLogTransactionFailure(logger) {
  try {
    logger.error("Legacy employee UID link transaction failed.", {
      event: "legacy_employee_uid_link_transaction_failed",
    });
  } catch {
    // Preserve the original safe service error if structured logging fails.
  }
}

function latestEmployeeData(snapshot) {
  if (!snapshot || snapshot.exists !== true || typeof snapshot.data !== "function") {
    throw serviceError(
      "failed-precondition",
      "EMPLOYEE_LINK_TARGET_MISSING",
      "The employee profile is no longer available for account linking.",
    );
  }

  const data = snapshot.data();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }
  return data;
}

function authLinkData(snapshot, employeeDocumentId) {
  if (!snapshot || typeof snapshot.exists !== "boolean") {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }
  if (!snapshot.exists) return null;
  if (typeof snapshot.data !== "function") {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee account could not be linked.",
    );
  }

  const data = snapshot.data();
  const hasExactFields = data
    && typeof data === "object"
    && !Array.isArray(data)
    && Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(data, field));
  const hasValidTimestamps = hasExactFields
    && typeof data.createdAt === "string"
    && !Number.isNaN(Date.parse(data.createdAt))
    && typeof data.updatedAt === "string"
    && !Number.isNaN(Date.parse(data.updatedAt));

  if (
    !hasValidTimestamps
    || typeof data.employeeId !== "string"
    || data.employeeId !== employeeDocumentId
  ) {
    throw serviceError(
      "failed-precondition",
      "UID_LINK_CONFLICT",
      "The authentication account has a conflicting employee link.",
    );
  }

  return data;
}

function authLinkRecord(employeeDocumentId, timestamp) {
  return {
    employeeId: employeeDocumentId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function linkEmployeeAtomically({
  firestore,
  logger,
  clock,
  collection,
  candidate,
  callerUid,
  callerEmail,
}) {
  let documentReference;
  let authLinkReference;
  try {
    documentReference = collection.doc(candidate.documentId);
    authLinkReference = firestore.collection("authLinks").doc(callerUid);
  } catch {
    throw serviceError(
      "internal",
      "EMPLOYEE_DOCUMENT_REFERENCE_FAILED",
      "Employee account could not be linked.",
    );
  }
  try {
    return await firestore.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(documentReference);
      const authLinkSnapshot = await transaction.get(authLinkReference);
      const latestData = latestEmployeeData(latestSnapshot);
      const existingAuthLink = authLinkData(authLinkSnapshot, candidate.documentId);

      assertMatchingEmail(latestData, callerEmail);

      const latestUid = normalizedEmployeeUid(latestData.uid);
      if (latestUid === callerUid) {
        if (!existingAuthLink) {
          const timestamp = currentTimestamp(clock);
          transaction.create(
            authLinkReference,
            authLinkRecord(candidate.documentId, timestamp),
          );
        }
        return idempotentResult(candidate.documentId);
      }
      if (latestUid !== null) {
        throw serviceError(
          "failed-precondition",
          "UID_LINK_CONFLICT",
          "The employee profile is linked to another authentication account.",
        );
      }

      assertActiveEmployee(latestData);
      const timestamp = currentTimestamp(clock);
      transaction.update(documentReference, { uid: callerUid, updatedAt: timestamp });
      if (!existingAuthLink) {
        transaction.create(
          authLinkReference,
          authLinkRecord(candidate.documentId, timestamp),
        );
      }
      return linkedResult(candidate.documentId);
    });
  } catch (error) {
    if (error instanceof LegacyEmployeeLinkServiceError) throw error;
    safeLogTransactionFailure(logger);
    throw serviceError(
      "internal",
      "LINK_TRANSACTION_FAILED",
      "Employee account could not be linked.",
    );
  }
}

function createLegacyEmployeeLinkService({ firestore, logger, clock }) {
  assertDependencies(firestore, logger, clock);

  return {
    async linkLegacyEmployee(callerUid, callerEmail) {
      const uid = normalizeCallerUid(callerUid);
      const email = normalizeCallerEmail(callerEmail);
      const collection = employeeCollection(firestore);

      const uidDocuments = await queryEmployees(
        collection,
        "uid",
        uid,
        UID_LOOKUP_FIELDS,
        "UID_LOOKUP_FAILED",
      );
      if (uidDocuments.length > 1) {
        throw serviceError(
          "failed-precondition",
          "DUPLICATE_UID_LINK",
          "The authentication account has invalid employee links.",
        );
      }
      if (uidDocuments.length === 1) {
        const linkedEmployee = employeeDocument(uidDocuments[0]);
        assertMatchingEmail(linkedEmployee.data, email);
        return linkEmployeeAtomically({
          firestore,
          logger,
          clock,
          collection,
          candidate: linkedEmployee,
          callerUid: uid,
          callerEmail: email,
        });
      }

      const emailDocuments = await queryEmployees(
        collection,
        "email",
        email,
        EMAIL_LOOKUP_FIELDS,
        "EMAIL_LOOKUP_FAILED",
      );
      if (emailDocuments.length === 0) {
        throw serviceError(
          "failed-precondition",
          "EMPLOYEE_NOT_FOUND",
          "No employee profile is available for account linking.",
        );
      }
      if (emailDocuments.length > 1) {
        throw serviceError(
          "failed-precondition",
          "DUPLICATE_EMAIL_LINK",
          "The employee email has invalid profile links.",
        );
      }

      const candidate = employeeDocument(emailDocuments[0]);
      assertMatchingEmail(candidate.data, email);
      assertActiveEmployee(candidate.data);
      if (normalizedEmployeeUid(candidate.data.uid) !== null) {
        throw serviceError(
          "failed-precondition",
          "UID_LINK_CONFLICT",
          "The employee profile is linked to another authentication account.",
        );
      }

      return linkEmployeeAtomically({
        firestore,
        logger,
        clock,
        collection,
        candidate,
        callerUid: uid,
        callerEmail: email,
      });
    },
  };
}

module.exports = {
  LegacyEmployeeLinkServiceError,
  createLegacyEmployeeLinkService,
};
