/* global exports, require */
"use strict";

const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {
  EmployeeInvitationServiceError,
  createEmployeeInvitationService,
} = require("./employeeInvitationService");
const {
  LegacyEmployeeLinkServiceError,
  createLegacyEmployeeLinkService,
} = require("./legacyEmployeeLinkService");
const {
  AuthSessionVerificationServiceError,
  createAuthSessionVerificationService,
} = require("./authSessionVerificationService");
const {
  ScopedWorkspaceServiceError,
  createScopedWorkspaceService,
} = require("./scopedWorkspaceService");
const {
  ProjectMutationServiceError,
  createProjectMutationService,
} = require("./projectMutationService");
const {
  KpiMutationServiceError,
  createKpiMutationService,
} = require("./kpiMutationService");
const {
  EmployeeMutationServiceError,
  createEmployeeMutationService,
} = require("./employeeMutationService");

if (getApps().length === 0) {
  initializeApp();
}

const adminApp = getApps()[0];
const employeeInvitationService = createEmployeeInvitationService({
  auth: getAuth(adminApp),
  firestore: getFirestore(adminApp),
  logger,
  clock: () => new Date(),
});
const legacyEmployeeLinkService = createLegacyEmployeeLinkService({
  firestore: getFirestore(adminApp),
  logger,
  clock: () => new Date(),
});
const authSessionVerificationService = createAuthSessionVerificationService({
  firestore: getFirestore(adminApp),
  legacyLinkOperation: (callerUid, callerEmail) =>
    legacyEmployeeLinkService.linkLegacyEmployee(callerUid, callerEmail),
  logger,
  clock: () => new Date(),
});
const scopedWorkspaceService = createScopedWorkspaceService({
  firestore: getFirestore(adminApp),
  logger,
});
const projectMutationService = createProjectMutationService({
  firestore: getFirestore(adminApp),
  logger,
  clock: () => new Date(),
});
const kpiMutationService = createKpiMutationService({
  firestore: getFirestore(adminApp),
  logger,
  clock: () => new Date(),
});
const employeeMutationService = createEmployeeMutationService({
  auth: getAuth(adminApp),
  firestore: getFirestore(adminApp),
  logger,
  clock: () => new Date(),
});

const ALLOWED_CALLABLE_ERROR_CODES = new Set([
  "unauthenticated",
  "permission-denied",
  "invalid-argument",
  "already-exists",
  "failed-precondition",
]);
const INTERNAL_ERROR_MESSAGE = "Employee invitation could not be completed.";

function safeServiceReason(error) {
  if (!(error instanceof EmployeeInvitationServiceError)) return "UNEXPECTED_ERROR";
  if (typeof error.reason !== "string" || !/^[A-Z0-9_]{1,64}$/.test(error.reason)) {
    return "UNEXPECTED_ERROR";
  }
  return error.reason;
}

function toCallableError(error) {
  const allowedServiceError = error instanceof EmployeeInvitationServiceError
    && ALLOWED_CALLABLE_ERROR_CODES.has(error.code);
  const callableCode = allowedServiceError ? error.code : "internal";

  logger.error("Employee invitation callable failed.", {
    callable: "inviteEmployee",
    code: callableCode,
    reason: safeServiceReason(error),
  });

  if (!allowedServiceError) {
    return new HttpsError("internal", INTERNAL_ERROR_MESSAGE);
  }
  return new HttpsError(callableCode, error.message);
}

const LEGACY_LINK_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", {
    code: "unauthenticated",
    message: "Authentication is required.",
  }],
  ["EMPLOYEE_NOT_FOUND", {
    code: "not-found",
    message: "Employee profile was not found.",
  }],
  ["DUPLICATE_UID_LINK", {
    code: "already-exists",
    message: "Employee account linkage is invalid.",
  }],
  ["DUPLICATE_EMAIL_LINK", {
    code: "already-exists",
    message: "Employee account linkage is invalid.",
  }],
  ["UID_EMAIL_MISMATCH", {
    code: "failed-precondition",
    message: "Employee account cannot be linked.",
  }],
  ["EMPLOYEE_INACTIVE", {
    code: "failed-precondition",
    message: "Employee account cannot be linked.",
  }],
  ["EMPLOYEE_LINK_TARGET_MISSING", {
    code: "failed-precondition",
    message: "Employee account cannot be linked.",
  }],
  ["UID_LINK_CONFLICT", {
    code: "failed-precondition",
    message: "Employee account cannot be linked.",
  }],
  ["INVALID_SERVICE_CONFIGURATION", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["EMPLOYEE_COLLECTION_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["INVALID_DATA_RESPONSE", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["UID_LOOKUP_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["EMAIL_LOOKUP_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["CLOCK_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["EMPLOYEE_DOCUMENT_REFERENCE_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
  ["LINK_TRANSACTION_FAILED", {
    code: "internal",
    message: "Employee account could not be linked.",
  }],
]);
const UNKNOWN_LEGACY_LINK_RESPONSE = {
  code: "internal",
  message: "Employee account could not be linked.",
};

function legacyLinkErrorResponse(error) {
  if (!(error instanceof LegacyEmployeeLinkServiceError)) {
    return { ...UNKNOWN_LEGACY_LINK_RESPONSE, reason: "UNEXPECTED_ERROR" };
  }

  const response = LEGACY_LINK_ERROR_RESPONSES.get(error.reason);
  if (!response) return { ...UNKNOWN_LEGACY_LINK_RESPONSE, reason: "UNEXPECTED_ERROR" };
  return { ...response, reason: error.reason };
}

function toLegacyLinkCallableError(error) {
  const response = legacyLinkErrorResponse(error);

  try {
    logger.error("Legacy employee UID link callable failed.", {
      callable: "linkLegacyEmployeeUid",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the generic callable error if structured logging fails.
  }

  return new HttpsError(response.code, response.message);
}

const AUTH_SESSION_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", {
    code: "unauthenticated",
    message: "Authentication is required.",
  }],
  ["INVALID_SELECTED_ROLE", {
    code: "invalid-argument",
    message: "Select a valid role before signing in.",
  }],
  ["AUTH_LINK_MISSING", {
    code: "failed-precondition",
    message: "Employee account linkage is unavailable.",
  }],
  ["AUTH_LINK_CONFLICT", {
    code: "failed-precondition",
    message: "Employee account linkage is invalid.",
  }],
  ["EMPLOYEE_NOT_FOUND", {
    code: "not-found",
    message: "Employee profile was not found.",
  }],
  ["EMPLOYEE_INACTIVE", {
    code: "failed-precondition",
    message: "This employee account is inactive. Contact an administrator.",
  }],
  ["EMAIL_MISMATCH", {
    code: "failed-precondition",
    message: "The authenticated account does not match its employee profile.",
  }],
  ["UID_MISMATCH", {
    code: "failed-precondition",
    message: "The authenticated account does not match its employee profile.",
  }],
  ["ROLE_MISMATCH", {
    code: "permission-denied",
    message: "These credentials do not belong to the selected role.",
  }],
  ["DATA_INTEGRITY_FAILURE", {
    code: "failed-precondition",
    message: "Employee account data could not be verified.",
  }],
  ["INVALID_SERVICE_CONFIGURATION", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["COLLECTION_REFERENCE_FAILED", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["DOCUMENT_REFERENCE_FAILED", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["AUTH_LINK_READ_FAILED", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["EMPLOYEE_READ_FAILED", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["LEGACY_LINK_FAILED", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
  ["UNEXPECTED_ERROR", {
    code: "internal",
    message: "Employee session verification is unavailable.",
  }],
]);
const UNKNOWN_AUTH_SESSION_RESPONSE = {
  code: "internal",
  message: "Employee session verification is unavailable.",
};

function authSessionErrorResponse(error) {
  if (!(error instanceof AuthSessionVerificationServiceError)) {
    return { ...UNKNOWN_AUTH_SESSION_RESPONSE, reason: "UNEXPECTED_ERROR" };
  }

  const response = AUTH_SESSION_ERROR_RESPONSES.get(error.reason);
  if (!response) return { ...UNKNOWN_AUTH_SESSION_RESPONSE, reason: "UNEXPECTED_ERROR" };
  return { ...response, reason: error.reason };
}

function toAuthSessionCallableError(error) {
  const response = authSessionErrorResponse(error);

  try {
    logger.error("Authentication session verification callable failed.", {
      callable: "verifyAuthSession",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the generic callable error if structured logging fails.
  }

  return new HttpsError(response.code, response.message);
}

const SCOPED_WORKSPACE_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", {
    code: "unauthenticated",
    message: "Authentication is required.",
  }],
  ["AUTH_LINK_MISSING", {
    code: "not-found",
    message: "Employee workspace was not found.",
  }],
  ["EMPLOYEE_NOT_FOUND", {
    code: "not-found",
    message: "Employee workspace was not found.",
  }],
  ["AUTH_LINK_CONFLICT", {
    code: "failed-precondition",
    message: "Employee workspace linkage is invalid.",
  }],
  ["EMPLOYEE_UID_MISMATCH", {
    code: "failed-precondition",
    message: "Employee workspace identity is invalid.",
  }],
  ["EMPLOYEE_INACTIVE", {
    code: "failed-precondition",
    message: "This employee account is inactive.",
  }],
  ["PRINCIPAL_SCOPE_INVALID", {
    code: "failed-precondition",
    message: "Employee workspace scope is invalid.",
  }],
  ["DATA_INTEGRITY_FAILURE", {
    code: "failed-precondition",
    message: "Employee workspace data is invalid.",
  }],
  ["ROLE_NOT_ALLOWED", {
    code: "permission-denied",
    message: "This account cannot access the scoped workspace.",
  }],
  ["INVALID_SERVICE_CONFIGURATION", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["COLLECTION_REFERENCE_FAILED", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["DOCUMENT_REFERENCE_FAILED", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["AUTH_LINK_READ_FAILED", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["EMPLOYEE_READ_FAILED", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["SCOPED_QUERY_FAILED", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["INVALID_DATA_RESPONSE", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
  ["UNEXPECTED_ERROR", {
    code: "internal",
    message: "Scoped workspace data is unavailable.",
  }],
]);
const UNKNOWN_SCOPED_WORKSPACE_RESPONSE = {
  code: "internal",
  message: "Scoped workspace data is unavailable.",
};

function scopedWorkspaceErrorResponse(error) {
  if (!(error instanceof ScopedWorkspaceServiceError)) {
    return { ...UNKNOWN_SCOPED_WORKSPACE_RESPONSE, reason: "UNEXPECTED_ERROR" };
  }
  const response = SCOPED_WORKSPACE_ERROR_RESPONSES.get(error.reason);
  if (!response) {
    return { ...UNKNOWN_SCOPED_WORKSPACE_RESPONSE, reason: "UNEXPECTED_ERROR" };
  }
  return { ...response, reason: error.reason };
}

function toScopedWorkspaceCallableError(error) {
  const response = scopedWorkspaceErrorResponse(error);
  try {
    logger.error("Scoped workspace callable failed.", {
      callable: "getScopedWorkspace",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the generic callable error if structured logging fails.
  }
  return new HttpsError(response.code, response.message);
}

const PROJECT_MUTATION_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", ["unauthenticated", "Authentication is required."]],
  ["INVALID_OPERATION_INPUT", ["invalid-argument", "A valid project operation is required."]],
  ["INVALID_OPERATION", ["invalid-argument", "A valid project operation is required."]],
  ["INVALID_OPERATION_SCHEMA", ["invalid-argument", "The project operation is invalid."]],
  ["INVALID_PROJECT_ID", ["invalid-argument", "A valid project identifier is required."]],
  ["INVALID_PROJECT_SCHEMA", ["invalid-argument", "A complete valid project is required."]],
  ["PROTECTED_PROJECT_FIELD", ["invalid-argument", "Protected project fields cannot be supplied."]],
  ["INVALID_PROJECT_FIELD", ["invalid-argument", "A required project field is invalid."]],
  ["INVALID_PROJECT_DATE", ["invalid-argument", "A project date is invalid."]],
  ["INVALID_PROJECT_DATE_ORDER", ["invalid-argument", "Due date must be on or after the start date."]],
  ["INVALID_PROJECT_STATUS", ["invalid-argument", "Project status is invalid."]],
  ["INVALID_RELATIONSHIP_ID", ["invalid-argument", "A project relationship is invalid."]],
  ["ASSIGNMENT_REQUIRED", ["invalid-argument", "At least one assigned employee is required."]],
  ["DUPLICATE_ASSIGNMENT", ["invalid-argument", "An employee cannot be assigned more than once."]],
  ["EMPLOYEE_REFERENCE_NOT_FOUND", ["invalid-argument", "A referenced employee was not found."]],
  ["EMPLOYEE_REFERENCE_INVALID", ["invalid-argument", "A referenced employee is invalid."]],
  ["INVALID_TEAM_LEAD_REFERENCE", ["invalid-argument", "The selected Team Lead is invalid."]],
  ["INVALID_EMPLOYEE_REFERENCE", ["invalid-argument", "An assigned employee is invalid."]],
  ["AUTH_LINK_MISSING", ["failed-precondition", "Employee account linkage is unavailable."]],
  ["AUTH_LINK_CONFLICT", ["failed-precondition", "Employee account linkage is invalid."]],
  ["EMPLOYEE_NOT_FOUND", ["not-found", "Employee profile was not found."]],
  ["PRINCIPAL_INVALID", ["failed-precondition", "Employee account data is invalid."]],
  ["PRINCIPAL_UID_MISMATCH", ["failed-precondition", "Employee account identity is invalid."]],
  ["PRINCIPAL_INACTIVE", ["permission-denied", "This employee account cannot manage projects."]],
  ["PRINCIPAL_SCOPE_INVALID", ["failed-precondition", "Employee project scope is invalid."]],
  ["ROLE_NOT_ALLOWED", ["permission-denied", "This employee account cannot manage projects."]],
  ["PROJECT_SCOPE_DENIED", ["permission-denied", "This project is outside the authorized scope."]],
  ["PROJECT_NOT_FOUND", ["not-found", "The project was not found."]],
  ["PROJECT_DATA_INVALID", ["failed-precondition", "Stored project data is invalid."]],
  ["PROJECT_REFERENCE_INVALID", ["failed-precondition", "Stored project references are invalid."]],
  ["PROJECT_ALREADY_EXISTS", ["already-exists", "The project already exists."]],
  ["PROJECT_TRANSACTION_CONFLICT", ["aborted", "The project changed. Please try again."]],
]);
const UNKNOWN_PROJECT_MUTATION_RESPONSE = {
  code: "internal",
  message: "Project management is unavailable.",
  reason: "UNEXPECTED_ERROR",
};

function projectMutationErrorResponse(error) {
  if (!(error instanceof ProjectMutationServiceError)) {
    return UNKNOWN_PROJECT_MUTATION_RESPONSE;
  }
  const allowed = PROJECT_MUTATION_ERROR_RESPONSES.get(error.reason);
  if (!allowed) return UNKNOWN_PROJECT_MUTATION_RESPONSE;
  return { code: allowed[0], message: allowed[1], reason: error.reason };
}

function toProjectMutationCallableError(error) {
  const response = projectMutationErrorResponse(error);
  try {
    logger.error("Project management callable failed.", {
      callable: "manageProject",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the safe callable error if structured logging fails.
  }
  return new HttpsError(response.code, response.message);
}

function projectOperationInput(data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const input = { operation: source.operation };
  if (Object.prototype.hasOwnProperty.call(source, "projectId")) {
    input.projectId = source.projectId;
  }
  if (Object.prototype.hasOwnProperty.call(source, "project")) {
    input.project = source.project;
  }
  return input;
}

const KPI_MUTATION_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", ["unauthenticated", "Authentication is required."]],
  ["INVALID_OPERATION_INPUT", ["invalid-argument", "A valid KPI operation is required."]],
  ["INVALID_OPERATION", ["invalid-argument", "A valid KPI operation is required."]],
  ["INVALID_OPERATION_SCHEMA", ["invalid-argument", "The KPI operation is invalid."]],
  ["INVALID_KPI_ID", ["invalid-argument", "A valid KPI identifier is required."]],
  ["INVALID_KPI_SCHEMA", ["invalid-argument", "A complete valid KPI record is required."]],
  ["INVALID_KPI_FIELD", ["invalid-argument", "A required KPI field is invalid."]],
  ["INVALID_KPI_NUMBER", ["invalid-argument", "A KPI numeric value is invalid."]],
  ["INVALID_KPI_STATUS", ["invalid-argument", "KPI status is invalid."]],
  ["INVALID_KPI_RATING", ["invalid-argument", "KPI rating must be an integer from 1 through 10."]],
  ["INVALID_KPI_UPDATE", ["invalid-argument", "The KPI update is invalid."]],
  ["INVALID_RATING_UPDATE", ["invalid-argument", "The KPI rating update is invalid."]],
  ["PROTECTED_KPI_FIELD", ["invalid-argument", "Protected KPI fields cannot be supplied."]],
  ["INVALID_RELATIONSHIP_ID", ["invalid-argument", "A KPI relationship is invalid."]],
  ["AUTH_LINK_MISSING", ["failed-precondition", "Employee account linkage is unavailable."]],
  ["AUTH_LINK_CONFLICT", ["failed-precondition", "Employee account linkage is invalid."]],
  ["EMPLOYEE_NOT_FOUND", ["not-found", "Employee profile was not found."]],
  ["PRINCIPAL_INVALID", ["failed-precondition", "Employee account data is invalid."]],
  ["PRINCIPAL_UID_MISMATCH", ["failed-precondition", "Employee account identity is invalid."]],
  ["PRINCIPAL_INACTIVE", ["permission-denied", "This employee account cannot manage KPIs."]],
  ["PRINCIPAL_SCOPE_INVALID", ["failed-precondition", "Employee KPI scope is invalid."]],
  ["ROLE_NOT_ALLOWED", ["permission-denied", "This employee account cannot manage KPIs."]],
  ["PROJECT_NOT_FOUND", ["not-found", "The related project was not found."]],
  ["PROJECT_DATA_INVALID", ["failed-precondition", "Stored project data is invalid."]],
  ["PROJECT_REFERENCE_INVALID", ["failed-precondition", "Stored project relationships are invalid."]],
  ["KPI_EMPLOYEE_NOT_ASSIGNED", ["failed-precondition", "The KPI employee is not assigned to the project."]],
  ["KPI_EMPLOYEE_REFERENCE_INVALID", ["failed-precondition", "The KPI employee reference is invalid."]],
  ["KPI_SCOPE_DENIED", ["permission-denied", "This KPI is outside the authorized scope."]],
  ["SELF_RATING_DENIED", ["permission-denied", "Employees cannot rate their own KPI."]],
  ["LEGACY_RATING_NOT_ALLOWED", ["failed-precondition", "Legacy KPI records cannot receive project ratings."]],
  ["KPI_NOT_FOUND", ["not-found", "The KPI record was not found."]],
  ["KPI_DATA_INVALID", ["failed-precondition", "Stored KPI data is invalid."]],
  ["KPI_ALREADY_EXISTS", ["already-exists", "The KPI record already exists."]],
  ["KPI_TRANSACTION_CONFLICT", ["aborted", "The KPI changed. Please try again."]],
]);
const UNKNOWN_KPI_MUTATION_RESPONSE = {
  code: "internal",
  message: "KPI management is unavailable.",
  reason: "UNEXPECTED_ERROR",
};

function kpiMutationErrorResponse(error) {
  if (!(error instanceof KpiMutationServiceError)) return UNKNOWN_KPI_MUTATION_RESPONSE;
  const allowed = KPI_MUTATION_ERROR_RESPONSES.get(error.reason);
  if (!allowed) return UNKNOWN_KPI_MUTATION_RESPONSE;
  return { code: allowed[0], message: allowed[1], reason: error.reason };
}

function toKpiMutationCallableError(error) {
  const response = kpiMutationErrorResponse(error);
  try {
    logger.error("KPI management callable failed.", {
      callable: "manageKpi",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the safe callable error if structured logging fails.
  }
  return new HttpsError(response.code, response.message);
}

function kpiOperationInput(data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const input = { operation: source.operation };
  if (Object.prototype.hasOwnProperty.call(source, "kpiId")) input.kpiId = source.kpiId;
  if (Object.prototype.hasOwnProperty.call(source, "kpi")) input.kpi = source.kpi;
  if (Object.prototype.hasOwnProperty.call(source, "updates")) input.updates = source.updates;
  return input;
}

const EMPLOYEE_MUTATION_ERROR_RESPONSES = new Map([
  ["INVALID_AUTH_IDENTITY", ["unauthenticated", "Authentication is required."]],
  ["INVALID_OPERATION_INPUT", ["invalid-argument", "A valid employee operation is required."]],
  ["INVALID_OPERATION", ["invalid-argument", "A valid employee operation is required."]],
  ["INVALID_OPERATION_SCHEMA", ["invalid-argument", "The employee operation is invalid."]],
  ["INVALID_EMPLOYEE_ID", ["invalid-argument", "A valid employee identifier is required."]],
  ["INVALID_EMPLOYEE_UPDATE", ["invalid-argument", "The employee update is invalid."]],
  ["PROTECTED_EMPLOYEE_FIELD", ["invalid-argument", "Protected employee fields cannot be supplied."]],
  ["UNSUPPORTED_EMPLOYEE_FIELD", ["invalid-argument", "The employee update contains an unsupported field."]],
  ["INVALID_EMPLOYEE_FIELD", ["invalid-argument", "An employee field is invalid."]],
  ["INVALID_EMAIL", ["invalid-argument", "Employee email is invalid."]],
  ["INVALID_ROLE", ["invalid-argument", "Employee role is invalid."]],
  ["INVALID_STATUS", ["invalid-argument", "Employee status is invalid."]],
  ["INVALID_COMPENSATION", ["invalid-argument", "Employee compensation is invalid."]],
  ["INVALID_JOIN_DATE", ["invalid-argument", "Employee join date is invalid."]],
  ["INVALID_TEAM_LEAD_ID", ["invalid-argument", "Selected Team Lead is invalid."]],
  ["INVALID_TEAM_LEAD", ["invalid-argument", "Selected Team Lead is invalid."]],
  ["INVALID_DEPARTMENT", ["invalid-argument", "Selected department is invalid."]],
  ["EMPLOYEE_EMAIL_EXISTS", ["already-exists", "Employee email is already in use."]],
  ["AUTH_EMAIL_EXISTS", ["already-exists", "Employee email is already in use."]],
  ["AUTH_LINK_MISSING", ["failed-precondition", "Employee account linkage is unavailable."]],
  ["AUTH_LINK_CONFLICT", ["failed-precondition", "Employee account linkage is invalid."]],
  ["TARGET_UID_CONFLICT", ["failed-precondition", "Employee account linkage is invalid."]],
  ["TARGET_AUTH_CONFLICT", ["failed-precondition", "Employee authentication data is invalid."]],
  ["PRINCIPAL_UID_MISMATCH", ["failed-precondition", "Employee account identity is invalid."]],
  ["PRINCIPAL_INVALID", ["failed-precondition", "Employee account data is invalid."]],
  ["TARGET_DATA_INVALID", ["failed-precondition", "Stored employee data is invalid."]],
  ["AUTH_COMPENSATION_FAILED", ["failed-precondition", "Employee identity cleanup must be retried."]],
  ["DELETE_PARTIAL_CLEANUP", ["failed-precondition", "Employee cleanup must be retried."]],
  ["PRINCIPAL_NOT_FOUND", ["not-found", "Employee profile was not found."]],
  ["TARGET_NOT_FOUND", ["not-found", "The employee was not found."]],
  ["PRINCIPAL_INACTIVE", ["permission-denied", "This account cannot manage employees."]],
  ["ROLE_NOT_ALLOWED", ["permission-denied", "This account cannot manage employees."]],
  ["EMPLOYEE_SCOPE_DENIED", ["permission-denied", "This employee is outside the authorized scope."]],
  ["SELF_DELETE_DENIED", ["permission-denied", "Employees cannot delete themselves."]],
  ["SELF_ROLE_CHANGE_DENIED", ["permission-denied", "Employees cannot change their own role."]],
  ["COMPENSATION_CHANGE_DENIED", ["permission-denied", "This account cannot change employee compensation."]],
  ["EMPLOYEE_TRANSACTION_CONFLICT", ["aborted", "The employee changed. Please try again."]],
]);
const UNKNOWN_EMPLOYEE_MUTATION_RESPONSE = {
  code: "internal",
  message: "Employee management is unavailable.",
  reason: "UNEXPECTED_ERROR",
};

function employeeMutationErrorResponse(error) {
  if (!(error instanceof EmployeeMutationServiceError)) {
    return UNKNOWN_EMPLOYEE_MUTATION_RESPONSE;
  }
  const allowed = EMPLOYEE_MUTATION_ERROR_RESPONSES.get(error.reason);
  if (!allowed) return UNKNOWN_EMPLOYEE_MUTATION_RESPONSE;
  return {
    code: allowed[0],
    message: allowed[1],
    reason: error.reason,
    partialResult: error.partialResult || null,
  };
}

function toEmployeeMutationCallableError(error) {
  const response = employeeMutationErrorResponse(error);
  try {
    logger.error("Employee management callable failed.", {
      callable: "manageEmployee",
      code: response.code,
      reason: response.reason,
    });
  } catch {
    // Preserve the safe callable error if structured logging fails.
  }
  const details = response.partialResult ? { partialResult: response.partialResult } : undefined;
  return new HttpsError(response.code, response.message, details);
}

function employeeOperationInput(data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const input = { operation: source.operation };
  if (Object.prototype.hasOwnProperty.call(source, "employeeId")) {
    input.employeeId = source.employeeId;
  }
  if (Object.prototype.hasOwnProperty.call(source, "updates")) {
    input.updates = source.updates;
  }
  return input;
}

exports.inviteEmployee = onCall(async (request) => {
  try {
    return await employeeInvitationService.inviteEmployee(
      request.auth?.uid,
      request.data,
    );
  } catch (error) {
    throw toCallableError(error);
  }
});

exports.linkLegacyEmployeeUid = onCall(async (request) => {
  try {
    return await legacyEmployeeLinkService.linkLegacyEmployee(
      request.auth?.uid,
      request.auth?.token?.email,
    );
  } catch (error) {
    throw toLegacyLinkCallableError(error);
  }
});

exports.verifyAuthSession = onCall(async (request) => {
  try {
    return await authSessionVerificationService.verifyAuthSession(
      request.auth?.uid,
      request.auth?.token?.email,
      request.data?.selectedRole,
    );
  } catch (error) {
    throw toAuthSessionCallableError(error);
  }
});

exports.getScopedWorkspace = onCall(async (request) => {
  try {
    return await scopedWorkspaceService.getScopedWorkspace(request.auth?.uid);
  } catch (error) {
    throw toScopedWorkspaceCallableError(error);
  }
});

exports.manageProject = onCall(async (request) => {
  try {
    return await projectMutationService.manageProject(
      request.auth?.uid,
      projectOperationInput(request.data),
    );
  } catch (error) {
    throw toProjectMutationCallableError(error);
  }
});

const manageKpiCallable = onCall(async (request) => {
  try {
    return await kpiMutationService.manageKpi(
      request.auth?.uid,
      kpiOperationInput(request.data),
    );
  } catch (error) {
    throw toKpiMutationCallableError(error);
  }
});
exports.manageKpi = manageKpiCallable;

const manageEmployeeCallable = onCall(async (request) => {
  try {
    return await employeeMutationService.manageEmployee(
      request.auth?.uid,
      employeeOperationInput(request.data),
    );
  } catch (error) {
    throw toEmployeeMutationCallableError(error);
  }
});
exports.manageEmployee = manageEmployeeCallable;
