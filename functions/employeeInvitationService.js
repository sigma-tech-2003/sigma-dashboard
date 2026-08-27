/* global module, require */
"use strict";

const {
  EmployeeInvitationPolicyError,
  buildEmployeeInvitationProfile,
} = require("./employeeInvitationPolicy");

const CREATOR_POLICY_FIELDS = ["role", "status", "dept"];
const EXISTING_EMPLOYEE_POLICY_FIELDS = ["email", "role", "dept"];

class EmployeeInvitationServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "EmployeeInvitationServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new EmployeeInvitationServiceError(code, reason, message);
}

function assertDependencies(auth, firestore, logger, clock) {
  const validAuth = auth
    && typeof auth.getUserByEmail === "function"
    && typeof auth.createUser === "function"
    && typeof auth.deleteUser === "function";
  const validFirestore = firestore
    && typeof firestore.collection === "function"
    && typeof firestore.batch === "function";
  const validLogger = logger && typeof logger.error === "function";

  if (!validAuth || !validFirestore || !validLogger || typeof clock !== "function") {
    throw serviceError(
      "failed-precondition",
      "INVALID_SERVICE_CONFIGURATION",
      "Employee invitation service is not configured.",
    );
  }
}

function normalizeCallerUid(callerUid) {
  if (typeof callerUid !== "string" || !callerUid.trim()) {
    throw serviceError(
      "unauthenticated",
      "UNAUTHENTICATED",
      "Authentication is required.",
    );
  }
  return callerUid.trim();
}

function getEmployeesCollection(firestore) {
  try {
    return firestore.collection("employees");
  } catch {
    throw serviceError(
      "internal",
      "EMPLOYEE_COLLECTION_FAILED",
      "Employee invitation could not be completed.",
    );
  }
}

function snapshotDocuments(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.docs)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee invitation could not be completed.",
    );
  }
  return snapshot.docs;
}

function documentData(document) {
  if (!document || typeof document.id !== "string" || typeof document.data !== "function") {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee invitation could not be completed.",
    );
  }

  const data = document.data();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Employee invitation could not be completed.",
    );
  }
  return data;
}

function creatorServiceError(reason, message) {
  const code = reason === "CREATOR_INACTIVE" ? "permission-denied" : "failed-precondition";
  return serviceError(code, reason, message);
}

async function resolveCreator(employeesCollection, callerUid) {
  let documents;
  try {
    const snapshot = await employeesCollection
      .where("uid", "==", callerUid)
      .select(...CREATOR_POLICY_FIELDS)
      .limit(2)
      .get();
    documents = snapshotDocuments(snapshot);
  } catch (error) {
    if (error instanceof EmployeeInvitationServiceError) throw error;
    throw serviceError(
      "internal",
      "CREATOR_LOOKUP_FAILED",
      "Employee invitation could not be completed.",
    );
  }

  if (documents.length === 0) {
    throw creatorServiceError(
      "CREATOR_NOT_FOUND",
      "Authenticated employee profile was not found.",
    );
  }
  if (documents.length !== 1) {
    throw creatorServiceError(
      "CREATOR_NOT_UNIQUE",
      "Authenticated employee profile is invalid.",
    );
  }

  let data;
  try {
    data = documentData(documents[0]);
  } catch (error) {
    if (error instanceof EmployeeInvitationServiceError) throw error;
    throw serviceError(
      "internal",
      "INVALID_CREATOR_PROFILE",
      "Employee invitation could not be completed.",
    );
  }

  if (typeof data.status !== "string" || data.status.trim().toLowerCase() !== "active") {
    throw creatorServiceError("CREATOR_INACTIVE", "Creator is not active.");
  }

  return {
    documentId: documents[0].id,
    profile: {
      role: data.role,
      status: data.status,
      dept: data.dept,
    },
  };
}

async function loadPolicyEmployees(employeesCollection) {
  let documents;
  try {
    const snapshot = await employeesCollection
      .select(...EXISTING_EMPLOYEE_POLICY_FIELDS)
      .get();
    documents = snapshotDocuments(snapshot);
  } catch (error) {
    if (error instanceof EmployeeInvitationServiceError) throw error;
    throw serviceError(
      "internal",
      "EMPLOYEE_LOOKUP_FAILED",
      "Employee invitation could not be completed.",
    );
  }

  try {
    return documents.map((document) => {
      const data = documentData(document);
      return {
        id: document.id,
        email: data.email,
        role: data.role,
        dept: data.dept,
      };
    });
  } catch (error) {
    if (error instanceof EmployeeInvitationServiceError) throw error;
    throw serviceError(
      "internal",
      "INVALID_EMPLOYEE_DATA",
      "Employee invitation could not be completed.",
    );
  }
}

function policyServiceError(error) {
  if (error.code === "DUPLICATE_EMAIL") {
    return serviceError("already-exists", error.code, error.message);
  }
  if (["CREATOR_NOT_ACTIVE", "CREATOR_NOT_AUTHORIZED", "SCOPE_VIOLATION"].includes(error.code)) {
    return serviceError("permission-denied", error.code, error.message);
  }
  return serviceError("invalid-argument", error.code, error.message);
}

function runPolicy(creator, invitationInput, existingEmployees) {
  try {
    return buildEmployeeInvitationProfile(
      creator.profile,
      creator.documentId,
      invitationInput,
      existingEmployees,
    );
  } catch (error) {
    if (error instanceof EmployeeInvitationPolicyError) throw policyServiceError(error);
    throw serviceError(
      "internal",
      "POLICY_EVALUATION_FAILED",
      "Employee invitation could not be completed.",
    );
  }
}

function adminErrorCode(error) {
  return error && typeof error.code === "string" ? error.code : "";
}

async function assertAuthEmailAvailable(auth, email) {
  try {
    await auth.getUserByEmail(email);
    throw serviceError(
      "already-exists",
      "AUTH_EMAIL_EXISTS",
      "An authentication account with this email already exists.",
    );
  } catch (error) {
    if (error instanceof EmployeeInvitationServiceError) throw error;
    if (adminErrorCode(error) === "auth/user-not-found") return;
    throw serviceError(
      "internal",
      "AUTH_EMAIL_LOOKUP_FAILED",
      "Employee invitation could not be completed.",
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
      "Employee invitation could not be completed.",
    );
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError(
      "internal",
      "CLOCK_FAILED",
      "Employee invitation could not be completed.",
    );
  }
  return date.toISOString();
}

async function createAuthUser(auth, profile) {
  let user;
  try {
    user = await auth.createUser({
      email: profile.email,
      displayName: profile.name,
      disabled: profile.status !== "active",
    });
  } catch (error) {
    if (adminErrorCode(error) === "auth/email-already-exists") {
      throw serviceError(
        "already-exists",
        "AUTH_EMAIL_EXISTS",
        "An authentication account with this email already exists.",
      );
    }
    throw serviceError(
      "internal",
      "AUTH_CREATE_FAILED",
      "Employee invitation could not be completed.",
    );
  }

  if (!user || typeof user.uid !== "string" || !user.uid.trim()) {
    throw serviceError(
      "internal",
      "INVALID_AUTH_RESPONSE",
      "Employee invitation could not be completed.",
    );
  }
  return user.uid.trim();
}

function displayEmployeeId(uid) {
  return `EMP-${uid}`;
}

async function createInvitationDocuments(
  firestore,
  employeesCollection,
  employeeUid,
  employeeRecord,
  timestamp,
) {
  const authLinkRecord = {
    employeeId: employeeUid,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    const employeeDocument = employeesCollection.doc(employeeUid);
    const authLinkDocument = firestore.collection("authLinks").doc(employeeUid);
    const batch = firestore.batch();
    batch.create(employeeDocument, employeeRecord);
    batch.create(authLinkDocument, authLinkRecord);
    await batch.commit();
  } catch {
    throw serviceError(
      "internal",
      "EMPLOYEE_CREATE_FAILED",
      "Employee invitation could not be completed.",
    );
  }
}

async function rollbackAuthUser(auth, uid, logger) {
  try {
    await auth.deleteUser(uid);
  } catch {
    try {
      logger.error("Employee invitation Auth rollback failed.", {
        event: "employee_invitation_auth_rollback_failed",
      });
    } catch {
      // Preserve the original safe service error even if the logger fails.
    }
  }
}

function createEmployeeInvitationService({ auth, firestore, logger, clock }) {
  assertDependencies(auth, firestore, logger, clock);

  return {
    async inviteEmployee(callerUid, invitationInput) {
      const normalizedCallerUid = normalizeCallerUid(callerUid);
      const employeesCollection = getEmployeesCollection(firestore);
      const creator = await resolveCreator(employeesCollection, normalizedCallerUid);
      const existingEmployees = await loadPolicyEmployees(employeesCollection);
      const profile = runPolicy(creator, invitationInput, existingEmployees);

      await assertAuthEmailAvailable(auth, profile.email);
      const timestamp = currentTimestamp(clock);
      const employeeUid = await createAuthUser(auth, profile);
      const empId = displayEmployeeId(employeeUid);
      const employeeRecord = {
        ...profile,
        uid: employeeUid,
        empId,
        createdByUid: normalizedCallerUid,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      try {
        await createInvitationDocuments(
          firestore,
          employeesCollection,
          employeeUid,
          employeeRecord,
          timestamp,
        );
      } catch (error) {
        await rollbackAuthUser(auth, employeeUid, logger);
        throw error;
      }

      return {
        employeeDocumentId: employeeUid,
        empId,
        email: profile.email,
        requiresPasswordSetup: true,
      };
    },
  };
}

module.exports = {
  EmployeeInvitationServiceError,
  createEmployeeInvitationService,
};
