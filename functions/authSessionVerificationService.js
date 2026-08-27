/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_DOCUMENT_ID_LENGTH = 1500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["admin", "hr", "manager", "tl", "employee"]);
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];

class AuthSessionVerificationServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "AuthSessionVerificationServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new AuthSessionVerificationServiceError(code, reason, message);
}

function assertDependencies(firestore, legacyLinkOperation, logger, clock) {
  const validFirestore = firestore && typeof firestore.collection === "function";
  const validLogger = logger && typeof logger.error === "function";

  if (
    !validFirestore
    || typeof legacyLinkOperation !== "function"
    || !validLogger
    || typeof clock !== "function"
  ) {
    throw serviceError(
      "internal",
      "INVALID_SERVICE_CONFIGURATION",
      "Employee session verification is unavailable.",
    );
  }
}

function hasInvalidUidCharacters(uid) {
  return [...uid].some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
  });
}

function normalizeCallerUid(value) {
  const uid = typeof value === "string" ? value.trim() : "";
  if (!uid || uid.length > MAX_FIREBASE_UID_LENGTH || hasInvalidUidCharacters(uid)) {
    throw serviceError(
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
      "Authentication is required.",
    );
  }
  return uid;
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

function normalizeCallerEmail(value) {
  const email = normalizeEmail(value);
  if (!email) {
    throw serviceError(
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
      "Authentication is required.",
    );
  }
  return email;
}

function validateSelectedRole(value) {
  if (typeof value !== "string" || !VALID_ROLES.has(value)) {
    throw serviceError(
      "invalid-argument",
      "INVALID_SELECTED_ROLE",
      "Select a valid role before signing in.",
    );
  }
  return value;
}

function normalizeDocumentId(value) {
  if (typeof value !== "string") return null;
  const documentId = value.trim();
  if (
    !documentId
    || documentId !== value
    || documentId.length > MAX_DOCUMENT_ID_LENGTH
    || documentId.includes("/")
    || [...documentId].some((character) => character.codePointAt(0) < 32)
  ) {
    return null;
  }
  return documentId;
}

function isValidTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeLogInternalFailure(logger, clock, reason) {
  const context = {
    event: "auth_session_verification_failed",
    reason,
  };

  try {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) context.occurredAt = date.toISOString();
  } catch {
    // Logging context must not replace the safe verification error.
  }

  try {
    logger.error("Employee session verification failed.", context);
  } catch {
    // Logging failures must not replace the safe verification error.
  }
}

function collectionReference(firestore, name) {
  try {
    const collection = firestore.collection(name);
    if (!collection || typeof collection.doc !== "function") throw new Error("invalid");
    return collection;
  } catch {
    throw serviceError(
      "internal",
      "COLLECTION_REFERENCE_FAILED",
      "Employee session verification is unavailable.",
    );
  }
}

function documentReference(collection, documentId) {
  try {
    const reference = collection.doc(documentId);
    if (!reference || typeof reference.get !== "function") throw new Error("invalid");
    return reference;
  } catch {
    throw serviceError(
      "internal",
      "DOCUMENT_REFERENCE_FAILED",
      "Employee session verification is unavailable.",
    );
  }
}

async function readDocument(reference, failureReason) {
  try {
    const snapshot = await reference.get();
    if (!snapshot || typeof snapshot.exists !== "boolean") {
      throw serviceError(
        "failed-precondition",
        "DATA_INTEGRITY_FAILURE",
        "Employee account data could not be verified.",
      );
    }
    return snapshot;
  } catch (error) {
    if (error instanceof AuthSessionVerificationServiceError) throw error;
    throw serviceError(
      "internal",
      failureReason,
      "Employee session verification is unavailable.",
    );
  }
}

function authLinkData(snapshot) {
  if (!snapshot.exists) return null;
  if (typeof snapshot.data !== "function") {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }

  const data = snapshot.data();
  const hasExactFields = data
    && typeof data === "object"
    && !Array.isArray(data)
    && Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(data, field));
  const employeeId = hasExactFields ? normalizeDocumentId(data.employeeId) : null;

  if (
    !employeeId
    || !isValidTimestamp(data.createdAt)
    || !isValidTimestamp(data.updatedAt)
  ) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }

  return { employeeId };
}

function validateRepairResult(result) {
  const employeeDocumentId = result && typeof result === "object" && !Array.isArray(result)
    ? normalizeDocumentId(result.employeeDocumentId)
    : null;

  if (!employeeDocumentId || result.linked !== true) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }
  return employeeDocumentId;
}

function mapLegacyLinkError(error) {
  const reason = typeof error?.reason === "string" ? error.reason : "";

  if (reason === "INVALID_AUTH_IDENTITY") {
    return serviceError("unauthenticated", "INVALID_AUTH_IDENTITY", "Authentication is required.");
  }
  if (reason === "EMPLOYEE_NOT_FOUND") {
    return serviceError("not-found", "EMPLOYEE_NOT_FOUND", "Employee profile was not found.");
  }
  if (reason === "EMPLOYEE_INACTIVE") {
    return serviceError(
      "failed-precondition",
      "EMPLOYEE_INACTIVE",
      "This employee account is inactive. Contact an administrator.",
    );
  }
  if (reason === "UID_EMAIL_MISMATCH") {
    return serviceError(
      "failed-precondition",
      "EMAIL_MISMATCH",
      "The authenticated account does not match its employee profile.",
    );
  }
  if ([
    "DUPLICATE_UID_LINK",
    "DUPLICATE_EMAIL_LINK",
    "EMPLOYEE_LINK_TARGET_MISSING",
    "UID_LINK_CONFLICT",
  ].includes(reason)) {
    return serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }

  return serviceError(
    "internal",
    "LEGACY_LINK_FAILED",
    "Employee session verification is unavailable.",
  );
}

async function resolveAuthLink({
  firestore,
  legacyLinkOperation,
  uid,
  email,
}) {
  const authLinks = collectionReference(firestore, "authLinks");
  const reference = documentReference(authLinks, uid);
  let snapshot = await readDocument(reference, "AUTH_LINK_READ_FAILED");
  let link = authLinkData(snapshot);

  if (link) return link;

  let repairedEmployeeId;
  try {
    repairedEmployeeId = validateRepairResult(await legacyLinkOperation(uid, email));
  } catch (error) {
    if (error instanceof AuthSessionVerificationServiceError) throw error;
    throw mapLegacyLinkError(error);
  }

  snapshot = await readDocument(reference, "AUTH_LINK_READ_FAILED");
  link = authLinkData(snapshot);
  if (!link) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_MISSING",
      "Employee account linkage is unavailable.",
    );
  }
  if (link.employeeId !== repairedEmployeeId) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }
  return link;
}

function employeeData(snapshot) {
  if (!snapshot.exists) {
    throw serviceError("not-found", "EMPLOYEE_NOT_FOUND", "Employee profile was not found.");
  }
  if (typeof snapshot.data !== "function") {
    throw serviceError(
      "failed-precondition",
      "DATA_INTEGRITY_FAILURE",
      "Employee account data could not be verified.",
    );
  }

  const data = snapshot.data();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw serviceError(
      "failed-precondition",
      "DATA_INTEGRITY_FAILURE",
      "Employee account data could not be verified.",
    );
  }
  return data;
}

function verifyEmployee(data, uid, email, selectedRole) {
  const employeeUid = typeof data.uid === "string" ? data.uid.trim() : "";
  if (!employeeUid || employeeUid !== uid) {
    throw serviceError(
      "failed-precondition",
      "UID_MISMATCH",
      "The authenticated account does not match its employee profile.",
    );
  }
  if (normalizeEmail(data.email) !== email) {
    throw serviceError(
      "failed-precondition",
      "EMAIL_MISMATCH",
      "The authenticated account does not match its employee profile.",
    );
  }
  if (typeof data.status !== "string" || data.status.trim().toLowerCase() !== "active") {
    throw serviceError(
      "failed-precondition",
      "EMPLOYEE_INACTIVE",
      "This employee account is inactive. Contact an administrator.",
    );
  }
  if (!VALID_ROLES.has(data.role)) {
    throw serviceError(
      "failed-precondition",
      "DATA_INTEGRITY_FAILURE",
      "Employee account data could not be verified.",
    );
  }
  if (data.role !== selectedRole) {
    throw serviceError(
      "permission-denied",
      "ROLE_MISMATCH",
      "These credentials do not belong to the selected role.",
    );
  }
}

function sanitizedEmployeePrincipal(documentId, data, email) {
  return {
    id: documentId,
    name: safeText(data.name),
    email,
    phone: safeText(data.phone),
    dept: safeText(data.dept),
    pos: safeText(data.pos),
    joinDate: safeText(data.joinDate),
    empId: safeText(data.empId),
    role: data.role,
  };
}

async function verifySession({
  firestore,
  legacyLinkOperation,
  logger,
  clock,
  callerUid,
  callerEmail,
  selectedRole,
}) {
  try {
    const uid = normalizeCallerUid(callerUid);
    const email = normalizeCallerEmail(callerEmail);
    const role = validateSelectedRole(selectedRole);
    const link = await resolveAuthLink({ firestore, legacyLinkOperation, uid, email });
    const employees = collectionReference(firestore, "employees");
    const employeeReference = documentReference(employees, link.employeeId);
    const snapshot = await readDocument(employeeReference, "EMPLOYEE_READ_FAILED");
    const data = employeeData(snapshot);

    verifyEmployee(data, uid, email, role);
    return {
      employee: sanitizedEmployeePrincipal(link.employeeId, data, email),
      linkage: "uid",
    };
  } catch (error) {
    if (error instanceof AuthSessionVerificationServiceError) {
      if (error.code === "internal") safeLogInternalFailure(logger, clock, error.reason);
      throw error;
    }
    safeLogInternalFailure(logger, clock, "UNEXPECTED_ERROR");
    throw serviceError(
      "internal",
      "UNEXPECTED_ERROR",
      "Employee session verification is unavailable.",
    );
  }
}

function createAuthSessionVerificationService({
  firestore,
  legacyLinkOperation,
  logger,
  clock,
}) {
  assertDependencies(firestore, legacyLinkOperation, logger, clock);

  return {
    verifyAuthSession(callerUid, callerEmail, selectedRole) {
      return verifySession({
        firestore,
        legacyLinkOperation,
        logger,
        clock,
        callerUid,
        callerEmail,
        selectedRole,
      });
    },
  };
}

module.exports = {
  AuthSessionVerificationServiceError,
  createAuthSessionVerificationService,
};
