/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];
const PROJECT_INPUT_FIELDS = [
  "title",
  "description",
  "department",
  "teamLeadId",
  "assignedEmployeeIds",
  "startDate",
  "dueDate",
  "status",
];
const PROJECT_RESPONSE_FIELDS = [
  ...PROJECT_INPUT_FIELDS,
  "createdAt",
  "updatedAt",
];
const PROTECTED_PROJECT_FIELDS = new Set([
  "id",
  "_docId",
  "name",
  "uid",
  "empId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "createdByUid",
  "creatorId",
  "creatorRole",
  "role",
]);
const ALLOWED_PROJECT_STATUSES = new Set(["draft", "active", "completed"]);
const MANAGING_ROLES = new Set(["admin", "hr", "manager", "tl"]);
const SAFE_REASON = /^[A-Z0-9_]{1,64}$/;

class ProjectMutationServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "ProjectMutationServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new ProjectMutationServiceError(code, reason, message);
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
      "Project management is unavailable.",
    );
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function normalizeDocumentId(value, reason = "INVALID_PROJECT_ID") {
  let normalized = "";
  if (typeof value === "string") normalized = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) normalized = String(value);
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw serviceError("invalid-argument", reason, "A valid project identifier is required.");
  }
  return normalized;
}

function normalizedRelationshipId(value, field) {
  let normalized = "";
  if (typeof value === "string") normalized = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) normalized = String(value);
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw serviceError(
      "invalid-argument",
      "INVALID_RELATIONSHIP_ID",
      `A valid ${field} is required.`,
    );
  }
  return normalized;
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function currentTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw serviceError("internal", "CLOCK_FAILED", "Project management is unavailable.");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError("internal", "CLOCK_FAILED", "Project management is unavailable.");
  }
  return date.toISOString();
}

function collectionReference(firestore, name) {
  try {
    const reference = firestore.collection(name);
    if (!reference || typeof reference.doc !== "function") throw new Error("invalid collection");
    return reference;
  } catch {
    throw serviceError("internal", "COLLECTION_REFERENCE_FAILED", "Project management is unavailable.");
  }
}

function documentReference(collection, id) {
  try {
    const reference = id === undefined ? collection.doc() : collection.doc(id);
    if (!reference || typeof reference.id !== "string" || !reference.id.trim()) {
      throw new Error("invalid document");
    }
    return reference;
  } catch {
    throw serviceError("internal", "DOCUMENT_REFERENCE_FAILED", "Project management is unavailable.");
  }
}

function snapshotObject(snapshot, missingReason, invalidReason, missingCode = "not-found") {
  if (!snapshot || snapshot.exists !== true) {
    throw serviceError(missingCode, missingReason, "The requested record was not found.");
  }
  if (typeof snapshot.data !== "function") {
    throw serviceError("failed-precondition", invalidReason, "Stored project data is invalid.");
  }
  const data = snapshot.data();
  if (!isPlainObject(data)) {
    throw serviceError("failed-precondition", invalidReason, "Stored project data is invalid.");
  }
  return data;
}

function resolveAuthLink(snapshot) {
  const data = snapshotObject(
    snapshot,
    "AUTH_LINK_MISSING",
    "AUTH_LINK_CONFLICT",
    "failed-precondition",
  );
  const exactShape = Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(data, field));
  let employeeId = null;
  if (exactShape) {
    try {
      employeeId = normalizeDocumentId(data.employeeId, "AUTH_LINK_CONFLICT");
    } catch {
      employeeId = null;
    }
  }
  if (!employeeId || !isTimestamp(data.createdAt) || !isTimestamp(data.updatedAt)) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }
  return employeeId;
}

function resolvePrincipal(snapshot, callerUid, employeeId) {
  const data = snapshotObject(snapshot, "EMPLOYEE_NOT_FOUND", "PRINCIPAL_INVALID");
  const uid = typeof data.uid === "string" ? data.uid.trim() : "";
  if (uid !== callerUid) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_UID_MISMATCH",
      "Employee account identity is invalid.",
    );
  }
  if (typeof data.status !== "string" || data.status.trim().toLowerCase() !== "active") {
    throw serviceError(
      "permission-denied",
      "PRINCIPAL_INACTIVE",
      "This employee account cannot manage projects.",
    );
  }
  const role = typeof data.role === "string" ? data.role.trim().toLowerCase() : "";
  if (!MANAGING_ROLES.has(role)) {
    throw serviceError(
      "permission-denied",
      "ROLE_NOT_ALLOWED",
      "This employee account cannot manage projects.",
    );
  }
  const department = typeof data.dept === "string" ? data.dept.trim() : "";
  if ((role === "manager" || role === "tl") && !department) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_SCOPE_INVALID",
      "Employee project scope is invalid.",
    );
  }
  return { id: employeeId, role, department, employee: data };
}

function assertExactKeys(value, expected, reason, message) {
  if (!isPlainObject(value)) throw serviceError("invalid-argument", reason, message);
  const expectedKeys = new Set(expected);
  const suppliedKeys = Object.keys(value);
  if (
    suppliedKeys.length !== expectedKeys.size
    || suppliedKeys.some((key) => !expectedKeys.has(key))
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw serviceError("invalid-argument", reason, message);
  }
}

function normalizeRequiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw serviceError(
      "invalid-argument",
      "INVALID_PROJECT_FIELD",
      `${field} is required.`,
    );
  }
  return normalized;
}

function normalizeDescription(value) {
  if (typeof value !== "string") {
    throw serviceError(
      "invalid-argument",
      "INVALID_PROJECT_FIELD",
      "Project description must be text.",
    );
  }
  return value.trim();
}

function normalizeProjectDate(value, field) {
  const normalized = normalizeRequiredText(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw serviceError("invalid-argument", "INVALID_PROJECT_DATE", `A valid ${field} is required.`);
  }
  return normalized;
}

function normalizeTeamLeadId(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizedRelationshipId(value, "Team Lead identifier");
}

function normalizeAssignments(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw serviceError(
      "invalid-argument",
      "ASSIGNMENT_REQUIRED",
      "At least one assigned employee is required.",
    );
  }
  const normalized = value.map((id) => normalizedRelationshipId(id, "employee identifier"));
  if (new Set(normalized).size !== normalized.length) {
    throw serviceError(
      "invalid-argument",
      "DUPLICATE_ASSIGNMENT",
      "An employee cannot be assigned more than once.",
    );
  }
  return normalized;
}

function normalizeProjectInput(value) {
  if (isPlainObject(value)) {
    const protectedField = Object.keys(value).find((field) => PROTECTED_PROJECT_FIELDS.has(field));
    if (protectedField) {
      throw serviceError(
        "invalid-argument",
        "PROTECTED_PROJECT_FIELD",
        "Protected project fields cannot be supplied.",
      );
    }
  }
  assertExactKeys(
    value,
    PROJECT_INPUT_FIELDS,
    "INVALID_PROJECT_SCHEMA",
    "A complete valid project profile is required.",
  );
  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (!ALLOWED_PROJECT_STATUSES.has(status)) {
    throw serviceError("invalid-argument", "INVALID_PROJECT_STATUS", "Project status is invalid.");
  }
  const startDate = normalizeProjectDate(value.startDate, "start date");
  const dueDate = normalizeProjectDate(value.dueDate, "due date");
  if (Date.parse(dueDate) < Date.parse(startDate)) {
    throw serviceError(
      "invalid-argument",
      "INVALID_PROJECT_DATE_ORDER",
      "Due date must be on or after the start date.",
    );
  }
  return {
    title: normalizeRequiredText(value.title, "Project title"),
    description: normalizeDescription(value.description),
    department: normalizeRequiredText(value.department, "Department"),
    teamLeadId: normalizeTeamLeadId(value.teamLeadId),
    assignedEmployeeIds: normalizeAssignments(value.assignedEmployeeIds),
    startDate,
    dueDate,
    status,
  };
}

function normalizeOperationInput(value) {
  if (!isPlainObject(value)) {
    throw serviceError("invalid-argument", "INVALID_OPERATION_INPUT", "A valid operation is required.");
  }
  const operation = typeof value.operation === "string" ? value.operation.trim() : "";
  if (!["create", "update", "delete"].includes(operation)) {
    throw serviceError("invalid-argument", "INVALID_OPERATION", "A valid project operation is required.");
  }
  const expectedKeys = operation === "create"
    ? ["operation", "project"]
    : operation === "update"
      ? ["operation", "projectId", "project"]
      : ["operation", "projectId"];
  assertExactKeys(
    value,
    expectedKeys,
    "INVALID_OPERATION_SCHEMA",
    "The project operation contains unsupported fields.",
  );
  return {
    operation,
    projectId: operation === "create" ? null : normalizeDocumentId(value.projectId),
    project: operation === "delete" ? null : normalizeProjectInput(value.project),
  };
}

function storedProject(projectId, data) {
  if (!isPlainObject(data)) {
    throw serviceError("failed-precondition", "PROJECT_DATA_INVALID", "Stored project data is invalid.");
  }
  const titleSource = typeof data.title === "string" && data.title.trim()
    ? data.title
    : data.name;
  let normalized;
  try {
    normalized = normalizeProjectInput({
      title: titleSource,
      description: data.description ?? "",
      department: data.department,
      teamLeadId: data.teamLeadId ?? null,
      assignedEmployeeIds: data.assignedEmployeeIds,
      startDate: data.startDate,
      dueDate: data.dueDate,
      status: data.status,
    });
  } catch (error) {
    if (error instanceof ProjectMutationServiceError) {
      throw serviceError(
        "failed-precondition",
        "PROJECT_DATA_INVALID",
        "Stored project data is invalid.",
      );
    }
    throw error;
  }
  if (!isTimestamp(data.createdAt) || !isTimestamp(data.updatedAt)) {
    throw serviceError("failed-precondition", "PROJECT_DATA_INVALID", "Stored project data is invalid.");
  }
  return {
    id: projectId,
    ...normalized,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function referenceIds(project) {
  return [project.teamLeadId, ...project.assignedEmployeeIds].filter(Boolean);
}

function employeeRecord(snapshot, id, missingCode, missingReason) {
  const data = snapshotObject(snapshot, missingReason, "EMPLOYEE_REFERENCE_INVALID", missingCode);
  const role = typeof data.role === "string" ? data.role.trim().toLowerCase() : "";
  const department = typeof data.dept === "string" ? data.dept.trim() : "";
  const status = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
  const teamLeadId = data.teamLeadId === null || data.teamLeadId === undefined || data.teamLeadId === ""
    ? null
    : normalizedRelationshipId(data.teamLeadId, "Team Lead identifier");
  return { id, role, department, status, teamLeadId };
}

async function loadReferencedEmployees(
  transaction,
  employees,
  ids,
  principal,
  existingRecords = null,
  storedReferences = false,
) {
  const uniqueIds = [...new Set(ids)];
  const records = existingRecords ? new Map(existingRecords) : new Map();
  if (!records.has(principal.id)) {
    records.set(principal.id, {
      id: principal.id,
      role: principal.role,
      department: principal.department,
      status: "active",
      teamLeadId: principal.employee.teamLeadId == null
        ? null
        : normalizedRelationshipId(principal.employee.teamLeadId, "Team Lead identifier"),
    });
  }
  for (const id of uniqueIds) {
    if (records.has(id)) continue;
    let snapshot;
    try {
      snapshot = await transaction.get(documentReference(employees, id));
    } catch (error) {
      if (error instanceof ProjectMutationServiceError) throw error;
      throw serviceError("internal", "EMPLOYEE_REFERENCE_READ_FAILED", "Project management is unavailable.");
    }
    try {
      records.set(id, employeeRecord(
        snapshot,
        id,
        storedReferences ? "failed-precondition" : "invalid-argument",
        storedReferences ? "PROJECT_REFERENCE_INVALID" : "EMPLOYEE_REFERENCE_NOT_FOUND",
      ));
    } catch (error) {
      if (
        storedReferences
        && error instanceof ProjectMutationServiceError
        && error.code !== "internal"
      ) {
        throw serviceError(
          "failed-precondition",
          "PROJECT_REFERENCE_INVALID",
          "Stored project references are invalid.",
        );
      }
      throw error;
    }
  }
  return records;
}

function assertProjectReferences(project, employeesById) {
  if (project.teamLeadId !== null) {
    const teamLead = employeesById.get(project.teamLeadId);
    if (
      !teamLead
      || teamLead.status !== "active"
      || teamLead.role !== "tl"
      || teamLead.department !== project.department
    ) {
      throw serviceError(
        "invalid-argument",
        "INVALID_TEAM_LEAD_REFERENCE",
        "The selected Team Lead is not valid for this project.",
      );
    }
  }
  project.assignedEmployeeIds.forEach((id) => {
    const employee = employeesById.get(id);
    if (
      !employee
      || employee.status !== "active"
      || employee.role !== "employee"
      || employee.department !== project.department
    ) {
      throw serviceError(
        "invalid-argument",
        "INVALID_EMPLOYEE_REFERENCE",
        "An assigned employee is not valid for this project.",
      );
    }
  });
}

function canManageExisting(principal, project, employeesById) {
  if (principal.role === "admin" || principal.role === "hr") return true;
  if (principal.role === "manager") return project.department === principal.department;
  if (principal.role !== "tl" || project.department !== principal.department) return false;
  if (project.teamLeadId === principal.id) return true;
  return project.assignedEmployeeIds.some((id) =>
    employeesById.get(id)?.teamLeadId === principal.id,
  );
}

function assertCandidateScope(principal, project, employeesById) {
  if (principal.role === "manager" && project.department !== principal.department) {
    throw serviceError(
      "permission-denied",
      "PROJECT_SCOPE_DENIED",
      "This project is outside the employee's authorized scope.",
    );
  }
  if (principal.role !== "tl") return;
  const teamAssignmentsValid = project.assignedEmployeeIds.every((id) =>
    employeesById.get(id)?.teamLeadId === principal.id,
  );
  if (
    project.department !== principal.department
    || project.teamLeadId !== principal.id
    || !teamAssignmentsValid
  ) {
    throw serviceError(
      "permission-denied",
      "PROJECT_SCOPE_DENIED",
      "This project is outside the employee's authorized scope.",
    );
  }
}

function assertCandidateIdentityScope(principal, project) {
  if (principal.role === "manager" && project.department !== principal.department) {
    throw serviceError(
      "permission-denied",
      "PROJECT_SCOPE_DENIED",
      "This project is outside the employee's authorized scope.",
    );
  }
  if (
    principal.role === "tl"
    && (project.department !== principal.department || project.teamLeadId !== principal.id)
  ) {
    throw serviceError(
      "permission-denied",
      "PROJECT_SCOPE_DENIED",
      "This project is outside the employee's authorized scope.",
    );
  }
}

function sanitizedProject(id, project) {
  const result = { id };
  PROJECT_RESPONSE_FIELDS.forEach((field) => {
    if (field === "assignedEmployeeIds") result[field] = [...project[field]];
    else result[field] = project[field];
  });
  return result;
}

function safeLogFailure(logger, reason) {
  try {
    logger.error("Project mutation service failed.", {
      event: "project_mutation_service_failed",
      reason: typeof reason === "string" && SAFE_REASON.test(reason)
        ? reason
        : "UNEXPECTED_ERROR",
    });
  } catch {
    // Logging failure must not replace a safe service error.
  }
}

function transactionFailure(error, logger) {
  if (error instanceof ProjectMutationServiceError) {
    if (error.code === "internal") safeLogFailure(logger, error.reason);
    return error;
  }
  const rawCode = typeof error?.code === "string" ? error.code : error?.code;
  if (rawCode === "already-exists" || rawCode === 6) {
    return serviceError("already-exists", "PROJECT_ALREADY_EXISTS", "The project already exists.");
  }
  if (rawCode === "aborted" || rawCode === 10) {
    return serviceError(
      "aborted",
      "PROJECT_TRANSACTION_CONFLICT",
      "The project changed during this operation. Please try again.",
    );
  }
  safeLogFailure(logger, "PROJECT_TRANSACTION_FAILED");
  return serviceError("internal", "PROJECT_TRANSACTION_FAILED", "Project management is unavailable.");
}

function createProjectMutationService({ firestore, logger, clock }) {
  assertDependencies(firestore, logger, clock);

  return {
    async manageProject(callerUid, untrustedInput) {
      const uid = normalizeCallerUid(callerUid);
      const input = normalizeOperationInput(untrustedInput);
      const timestamp = input.operation === "delete" ? null : currentTimestamp(clock);
      const authLinks = collectionReference(firestore, "authLinks");
      const employees = collectionReference(firestore, "employees");
      const projects = collectionReference(firestore, "projects");
      const projectReference = input.operation === "create"
        ? documentReference(projects)
        : documentReference(projects, input.projectId);

      try {
        return await firestore.runTransaction(async (transaction) => {
          if (
            !transaction
            || typeof transaction.get !== "function"
            || typeof transaction.create !== "function"
            || typeof transaction.set !== "function"
            || typeof transaction.delete !== "function"
          ) {
            throw serviceError(
              "internal",
              "INVALID_TRANSACTION",
              "Project management is unavailable.",
            );
          }

          const authLinkSnapshot = await transaction.get(documentReference(authLinks, uid));
          const employeeId = resolveAuthLink(authLinkSnapshot);
          const principalSnapshot = await transaction.get(documentReference(employees, employeeId));
          const principal = resolvePrincipal(principalSnapshot, uid, employeeId);

          let latestProject = null;
          if (input.operation !== "create") {
            const projectSnapshot = await transaction.get(projectReference);
            const data = snapshotObject(projectSnapshot, "PROJECT_NOT_FOUND", "PROJECT_DATA_INVALID");
            latestProject = storedProject(projectReference.id, data);
          }

          let employeesById = await loadReferencedEmployees(
            transaction,
            employees,
            latestProject ? referenceIds(latestProject) : [],
            principal,
            null,
            Boolean(latestProject),
          );

          if (latestProject) {
            try {
              assertProjectReferences(latestProject, employeesById);
            } catch (error) {
              if (error instanceof ProjectMutationServiceError) {
                throw serviceError(
                  "failed-precondition",
                  "PROJECT_REFERENCE_INVALID",
                  "Stored project references are invalid.",
                );
              }
              throw error;
            }
            if (!canManageExisting(principal, latestProject, employeesById)) {
              throw serviceError(
                "permission-denied",
                "PROJECT_SCOPE_DENIED",
                "This project is outside the employee's authorized scope.",
              );
            }
          }

          if (input.operation === "delete") {
            transaction.delete(projectReference);
            return { id: projectReference.id, deleted: true };
          }

          assertCandidateIdentityScope(principal, input.project);
          employeesById = await loadReferencedEmployees(
            transaction,
            employees,
            referenceIds(input.project),
            principal,
            employeesById,
          );
          assertProjectReferences(input.project, employeesById);
          assertCandidateScope(principal, input.project, employeesById);
          const projectRecord = {
            ...input.project,
            createdAt: input.operation === "update" ? latestProject.createdAt : timestamp,
            updatedAt: timestamp,
          };

          if (input.operation === "create") transaction.create(projectReference, projectRecord);
          else transaction.set(projectReference, projectRecord);
          return sanitizedProject(projectReference.id, projectRecord);
        });
      } catch (error) {
        throw transactionFailure(error, logger);
      }
    },
  };
}

module.exports = {
  ProjectMutationServiceError,
  createProjectMutationService,
};
