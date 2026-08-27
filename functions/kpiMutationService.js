/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];
const MANAGING_ROLES = new Set(["admin", "hr", "manager", "tl"]);
const ALLOWED_KPI_STATUSES = new Set(["active"]);
const CREATE_KPI_FIELDS = [
  "projectId",
  "empId",
  "title",
  "target",
  "current",
  "weight",
  "period",
  "status",
];
const PROGRESS_UPDATE_FIELDS = new Set([
  "title",
  "target",
  "current",
  "weight",
  "period",
  "status",
]);
const PROTECTED_KPI_FIELDS = new Set([
  "id",
  "_docId",
  "projectId",
  "empId",
  "percentage",
  "ratingLabel",
  "ratedBy",
  "ratedAt",
  "createdAt",
  "updatedAt",
  "createdBy",
  "createdByUid",
  "creatorId",
  "creatorRole",
  "reviewerId",
  "reviewerRole",
  "role",
]);
const SAFE_REASON = /^[A-Z0-9_]{1,64}$/;

class KpiMutationServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "KpiMutationServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new KpiMutationServiceError(code, reason, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDependencies(firestore, logger, clock) {
  const validFirestore = firestore
    && typeof firestore.collection === "function"
    && typeof firestore.runTransaction === "function";
  if (!validFirestore || !logger || typeof logger.error !== "function" || typeof clock !== "function") {
    throw serviceError(
      "failed-precondition",
      "INVALID_SERVICE_CONFIGURATION",
      "KPI management is unavailable.",
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
    throw serviceError("unauthenticated", "INVALID_AUTH_IDENTITY", "Authentication is required.");
  }
  return uid;
}

function normalizeDocumentId(value, reason, label) {
  let normalized = "";
  if (typeof value === "string") normalized = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) normalized = String(value);
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw serviceError("invalid-argument", reason, `A valid ${label} is required.`);
  }
  return normalized;
}

function normalizeRelationshipId(value, field) {
  return normalizeDocumentId(value, "INVALID_RELATIONSHIP_ID", field);
}

function isTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function currentTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw serviceError("internal", "CLOCK_FAILED", "KPI management is unavailable.");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError("internal", "CLOCK_FAILED", "KPI management is unavailable.");
  }
  return date.toISOString();
}

function collectionReference(firestore, name) {
  try {
    const reference = firestore.collection(name);
    if (!reference || typeof reference.doc !== "function") throw new Error("invalid collection");
    return reference;
  } catch {
    throw serviceError("internal", "COLLECTION_REFERENCE_FAILED", "KPI management is unavailable.");
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
    throw serviceError("internal", "DOCUMENT_REFERENCE_FAILED", "KPI management is unavailable.");
  }
}

function snapshotData(snapshot, missingCode, missingReason, invalidReason, message) {
  if (!snapshot || snapshot.exists !== true) {
    throw serviceError(missingCode, missingReason, message);
  }
  if (typeof snapshot.data !== "function") {
    throw serviceError("failed-precondition", invalidReason, message);
  }
  const data = snapshot.data();
  if (!isPlainObject(data)) {
    throw serviceError("failed-precondition", invalidReason, message);
  }
  return data;
}

function resolveAuthLink(snapshot) {
  const data = snapshotData(
    snapshot,
    "failed-precondition",
    "AUTH_LINK_MISSING",
    "AUTH_LINK_CONFLICT",
    "Employee account linkage is invalid.",
  );
  const exactShape = Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(data, field));
  let employeeId = null;
  if (exactShape) {
    try {
      employeeId = normalizeDocumentId(data.employeeId, "AUTH_LINK_CONFLICT", "employee link");
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

function normalizeOptionalTeamLeadId(value, stored = false) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return normalizeRelationshipId(value, "Team Lead identifier");
  } catch (error) {
    if (stored && error instanceof KpiMutationServiceError) {
      throw serviceError("failed-precondition", "EMPLOYEE_REFERENCE_INVALID", "Stored employee data is invalid.");
    }
    throw error;
  }
}

function employeeRecord(snapshot, id, options = {}) {
  const { principal = false } = options;
  const data = snapshotData(
    snapshot,
    principal ? "not-found" : "invalid-argument",
    principal ? "EMPLOYEE_NOT_FOUND" : "EMPLOYEE_REFERENCE_NOT_FOUND",
    principal ? "PRINCIPAL_INVALID" : "EMPLOYEE_REFERENCE_INVALID",
    principal ? "Employee profile was not found." : "A referenced employee is invalid.",
  );
  const role = typeof data.role === "string" ? data.role.trim().toLowerCase() : "";
  const department = typeof data.dept === "string" ? data.dept.trim() : "";
  const status = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
  let teamLeadId;
  try {
    teamLeadId = normalizeOptionalTeamLeadId(data.teamLeadId, true);
  } catch (error) {
    if (principal && error instanceof KpiMutationServiceError) {
      throw serviceError("failed-precondition", "PRINCIPAL_INVALID", "Employee account data is invalid.");
    }
    throw error;
  }
  return { id, data, role, department, status, teamLeadId };
}

function resolvePrincipal(snapshot, callerUid, employeeId) {
  const principal = employeeRecord(snapshot, employeeId, { principal: true });
  const storedUid = typeof principal.data.uid === "string" ? principal.data.uid.trim() : "";
  if (storedUid !== callerUid) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_UID_MISMATCH",
      "Employee account identity is invalid.",
    );
  }
  if (principal.status !== "active") {
    throw serviceError(
      "permission-denied",
      "PRINCIPAL_INACTIVE",
      "This employee account cannot manage KPIs.",
    );
  }
  if (!MANAGING_ROLES.has(principal.role)) {
    throw serviceError(
      "permission-denied",
      "ROLE_NOT_ALLOWED",
      "This employee account cannot manage KPIs.",
    );
  }
  if ((principal.role === "manager" || principal.role === "tl") && !principal.department) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_SCOPE_INVALID",
      "Employee KPI scope is invalid.",
    );
  }
  return principal;
}

function assertExactKeys(value, expected, reason, message) {
  if (!isPlainObject(value)) throw serviceError("invalid-argument", reason, message);
  const expectedSet = new Set(expected);
  const keys = Object.keys(value);
  if (
    keys.length !== expectedSet.size
    || keys.some((key) => !expectedSet.has(key))
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw serviceError("invalid-argument", reason, message);
  }
}

function normalizeRequiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw serviceError("invalid-argument", "INVALID_KPI_FIELD", `${field} is required.`);
  }
  return normalized;
}

function normalizeFiniteNumber(value, field, predicate) {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numericValue) || !predicate(numericValue)) {
    throw serviceError("invalid-argument", "INVALID_KPI_NUMBER", `${field} is invalid.`);
  }
  return numericValue;
}

function normalizeStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ALLOWED_KPI_STATUSES.has(status)) {
    throw serviceError("invalid-argument", "INVALID_KPI_STATUS", "KPI status is invalid.");
  }
  return status;
}

function normalizeRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(numericValue) || numericValue < 1 || numericValue > 10) {
    throw serviceError("invalid-argument", "INVALID_KPI_RATING", "KPI rating must be an integer from 1 through 10.");
  }
  return numericValue;
}

function normalizeCoreKpi(value) {
  return {
    title: normalizeRequiredText(value.title, "KPI title"),
    target: normalizeFiniteNumber(value.target, "KPI target", (number) => number > 0),
    current: normalizeFiniteNumber(value.current, "KPI current value", (number) => number >= 0),
    weight: normalizeFiniteNumber(
      value.weight,
      "KPI weight",
      (number) => number >= 1 && number <= 100,
    ),
    period: normalizeRequiredText(value.period, "KPI period"),
    status: normalizeStatus(value.status),
  };
}

function normalizeCreateKpi(value) {
  if (isPlainObject(value)) {
    const protectedField = Object.keys(value).find((field) =>
      PROTECTED_KPI_FIELDS.has(field) && !CREATE_KPI_FIELDS.includes(field));
    if (protectedField) {
      throw serviceError(
        "invalid-argument",
        "PROTECTED_KPI_FIELD",
        "Protected KPI fields cannot be supplied.",
      );
    }
  }
  assertExactKeys(
    value,
    CREATE_KPI_FIELDS,
    "INVALID_KPI_SCHEMA",
    "A complete valid KPI record is required.",
  );
  return {
    projectId: normalizeRelationshipId(value.projectId, "project identifier"),
    empId: normalizeRelationshipId(value.empId, "employee identifier"),
    ...normalizeCoreKpi(value),
  };
}

function normalizeUpdate(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw serviceError("invalid-argument", "INVALID_KPI_UPDATE", "A valid KPI update is required.");
  }
  const keys = Object.keys(value);
  const protectedField = keys.find((field) => PROTECTED_KPI_FIELDS.has(field));
  if (protectedField) {
    throw serviceError(
      "invalid-argument",
      "PROTECTED_KPI_FIELD",
      "Protected KPI fields cannot be supplied.",
    );
  }
  if (keys.includes("rating")) {
    if (keys.length !== 1) {
      throw serviceError(
        "invalid-argument",
        "INVALID_RATING_UPDATE",
        "A rating update cannot change other KPI fields.",
      );
    }
    const rating = normalizeRating(value.rating);
    if (rating === null) {
      throw serviceError("invalid-argument", "INVALID_KPI_RATING", "A valid KPI rating is required.");
    }
    return { kind: "rating", values: { rating } };
  }
  if (keys.some((field) => !PROGRESS_UPDATE_FIELDS.has(field))) {
    throw serviceError("invalid-argument", "INVALID_KPI_UPDATE", "The KPI update contains unsupported fields.");
  }
  const normalized = {};
  keys.forEach((field) => {
    if (field === "title" || field === "period") {
      normalized[field] = normalizeRequiredText(value[field], field === "title" ? "KPI title" : "KPI period");
    } else if (field === "target") {
      normalized.target = normalizeFiniteNumber(value.target, "KPI target", (number) => number > 0);
    } else if (field === "current") {
      normalized.current = normalizeFiniteNumber(value.current, "KPI current value", (number) => number >= 0);
    } else if (field === "weight") {
      normalized.weight = normalizeFiniteNumber(
        value.weight,
        "KPI weight",
        (number) => number >= 1 && number <= 100,
      );
    } else if (field === "status") normalized.status = normalizeStatus(value.status);
  });
  return { kind: "progress", values: normalized };
}

function normalizeOperationInput(value) {
  if (!isPlainObject(value)) {
    throw serviceError("invalid-argument", "INVALID_OPERATION_INPUT", "A valid KPI operation is required.");
  }
  const operation = typeof value.operation === "string" ? value.operation.trim().toLowerCase() : "";
  if (!["create", "update", "delete"].includes(operation)) {
    throw serviceError("invalid-argument", "INVALID_OPERATION", "A valid KPI operation is required.");
  }
  const expected = operation === "create"
    ? ["operation", "kpi"]
    : operation === "update"
      ? ["operation", "kpiId", "updates"]
      : ["operation", "kpiId"];
  assertExactKeys(value, expected, "INVALID_OPERATION_SCHEMA", "The KPI operation is invalid.");
  return {
    operation,
    kpiId: operation === "create"
      ? null
      : normalizeDocumentId(value.kpiId, "INVALID_KPI_ID", "KPI identifier"),
    kpi: operation === "create" ? normalizeCreateKpi(value.kpi) : null,
    update: operation === "update" ? normalizeUpdate(value.updates) : null,
  };
}

function storedKpi(id, value) {
  if (!isPlainObject(value)) {
    throw serviceError("failed-precondition", "KPI_DATA_INVALID", "Stored KPI data is invalid.");
  }
  try {
    const projectId = value.projectId === null || value.projectId === undefined || value.projectId === ""
      ? null
      : normalizeRelationshipId(value.projectId, "project identifier");
    const rating = normalizeRating(value.rating);
    const ratedBy = value.ratedBy === null || value.ratedBy === undefined || value.ratedBy === ""
      ? null
      : normalizeRelationshipId(value.ratedBy, "reviewer identifier");
    const ratedAt = value.ratedAt === null || value.ratedAt === undefined || value.ratedAt === ""
      ? null
      : value.ratedAt;
    if (ratedAt !== null && !isTimestamp(ratedAt)) throw new Error("invalid ratedAt");
    if (value.createdAt !== undefined && value.createdAt !== null && !isTimestamp(value.createdAt)) {
      throw new Error("invalid createdAt");
    }
    if (value.updatedAt !== undefined && value.updatedAt !== null && !isTimestamp(value.updatedAt)) {
      throw new Error("invalid updatedAt");
    }
    return {
      id,
      projectId,
      empId: normalizeRelationshipId(value.empId, "employee identifier"),
      ...normalizeCoreKpi(value),
      rating,
      ratedBy,
      ratedAt,
      createdAt: value.createdAt ?? null,
      updatedAt: value.updatedAt ?? null,
    };
  } catch (error) {
    if (error instanceof KpiMutationServiceError && error.code === "internal") throw error;
    throw serviceError("failed-precondition", "KPI_DATA_INVALID", "Stored KPI data is invalid.");
  }
}

function storedProject(id, value) {
  if (!isPlainObject(value)) {
    throw serviceError("failed-precondition", "PROJECT_DATA_INVALID", "Stored project data is invalid.");
  }
  try {
    const department = normalizeRequiredText(value.department, "Project department");
    const assignedSource = value.assignedEmployeeIds;
    if (!Array.isArray(assignedSource) || assignedSource.length === 0) throw new Error("assignments");
    const assignedEmployeeIds = assignedSource.map((employeeId) =>
      normalizeRelationshipId(employeeId, "employee identifier"));
    if (new Set(assignedEmployeeIds).size !== assignedEmployeeIds.length) {
      throw new Error("duplicate assignments");
    }
    return {
      id,
      department,
      teamLeadId: normalizeOptionalTeamLeadId(value.teamLeadId),
      assignedEmployeeIds,
    };
  } catch {
    throw serviceError("failed-precondition", "PROJECT_DATA_INVALID", "Stored project data is invalid.");
  }
}

async function transactionGet(transaction, reference, reason) {
  try {
    return await transaction.get(reference);
  } catch (error) {
    if (error instanceof KpiMutationServiceError) throw error;
    throw serviceError("internal", reason, "KPI management is unavailable.");
  }
}

async function loadEmployee(transaction, employees, id, storedReason = null) {
  const snapshot = await transactionGet(
    transaction,
    documentReference(employees, id),
    "EMPLOYEE_REFERENCE_READ_FAILED",
  );
  try {
    return employeeRecord(snapshot, id);
  } catch (error) {
    if (storedReason && error instanceof KpiMutationServiceError && error.code !== "internal") {
      throw serviceError("failed-precondition", storedReason, "Stored KPI relationships are invalid.");
    }
    throw error;
  }
}

async function loadProjectContext(transaction, collections, projectId, targetEmployeeId) {
  const projectSnapshot = await transactionGet(
    transaction,
    documentReference(collections.projects, projectId),
    "PROJECT_READ_FAILED",
  );
  const projectData = snapshotData(
    projectSnapshot,
    "not-found",
    "PROJECT_NOT_FOUND",
    "PROJECT_DATA_INVALID",
    "The related project was not found.",
  );
  const project = storedProject(projectId, projectData);
  const employeeIds = [...new Set([
    ...project.assignedEmployeeIds,
    project.teamLeadId,
    targetEmployeeId,
  ].filter(Boolean))];
  const employeesById = new Map();
  for (const employeeId of employeeIds) {
    const employee = await loadEmployee(
      transaction,
      collections.employees,
      employeeId,
      "PROJECT_REFERENCE_INVALID",
    );
    employeesById.set(employeeId, employee);
  }
  if (project.teamLeadId) {
    const teamLead = employeesById.get(project.teamLeadId);
    if (
      !teamLead
      || teamLead.status !== "active"
      || teamLead.role !== "tl"
      || teamLead.department !== project.department
    ) {
      throw serviceError("failed-precondition", "PROJECT_REFERENCE_INVALID", "Stored project relationships are invalid.");
    }
  }
  for (const employeeId of project.assignedEmployeeIds) {
    const employee = employeesById.get(employeeId);
    if (
      !employee
      || employee.status !== "active"
      || employee.role !== "employee"
      || employee.department !== project.department
    ) {
      throw serviceError("failed-precondition", "PROJECT_REFERENCE_INVALID", "Stored project relationships are invalid.");
    }
  }
  const targetEmployee = employeesById.get(targetEmployeeId);
  if (
    !targetEmployee
    || targetEmployee.status !== "active"
    || targetEmployee.role !== "employee"
    || targetEmployee.department !== project.department
    || !project.assignedEmployeeIds.includes(targetEmployeeId)
  ) {
    throw serviceError(
      "failed-precondition",
      "KPI_EMPLOYEE_NOT_ASSIGNED",
      "The KPI employee is not assigned to the related project.",
    );
  }
  return { project, targetEmployee, employeesById };
}

function canManageProject(principal, context) {
  if (principal.role === "admin" || principal.role === "hr") return true;
  if (principal.role === "manager") {
    return context.project.department === principal.department
      && context.targetEmployee.department === principal.department;
  }
  if (principal.role !== "tl" || context.project.department !== principal.department) return false;
  const projectInScope = context.project.teamLeadId === principal.id
    || context.project.assignedEmployeeIds.some((employeeId) =>
      context.employeesById.get(employeeId)?.teamLeadId === principal.id);
  const employeeInScope = context.targetEmployee.id === principal.id
    || context.targetEmployee.teamLeadId === principal.id;
  return projectInScope && employeeInScope;
}

function canManageLegacy(principal, employee) {
  if (principal.role === "admin" || principal.role === "hr") return true;
  if (principal.role === "manager") return employee.department === principal.department;
  if (principal.role !== "tl" || employee.department !== principal.department) return false;
  return employee.id === principal.id || employee.teamLeadId === principal.id;
}

async function authorizeKpi(transaction, collections, principal, kpi, operationKind) {
  if (kpi.projectId) {
    const context = await loadProjectContext(
      transaction,
      collections,
      kpi.projectId,
      kpi.empId,
    );
    if (!canManageProject(principal, context)) {
      throw serviceError("permission-denied", "KPI_SCOPE_DENIED", "This KPI is outside the authorized scope.");
    }
    if (operationKind === "rating" && kpi.empId === principal.id) {
      throw serviceError("permission-denied", "SELF_RATING_DENIED", "Employees cannot rate their own KPI.");
    }
    return;
  }
  if (operationKind === "rating") {
    throw serviceError(
      "failed-precondition",
      "LEGACY_RATING_NOT_ALLOWED",
      "Legacy KPI records cannot receive project ratings.",
    );
  }
  const employee = await loadEmployee(
    transaction,
    collections.employees,
    kpi.empId,
    "KPI_EMPLOYEE_REFERENCE_INVALID",
  );
  if (employee.status !== "active") {
    throw serviceError("failed-precondition", "KPI_EMPLOYEE_REFERENCE_INVALID", "The KPI employee is invalid.");
  }
  if (!canManageLegacy(principal, employee)) {
    throw serviceError("permission-denied", "KPI_SCOPE_DENIED", "This KPI is outside the authorized scope.");
  }
}

function sanitizedKpi(id, kpi) {
  const result = {
    id,
    empId: kpi.empId,
    title: kpi.title,
    target: kpi.target,
    current: kpi.current,
    weight: kpi.weight,
    period: kpi.period,
    status: kpi.status,
    rating: kpi.rating,
    ratedBy: kpi.ratedBy,
    ratedAt: kpi.ratedAt,
  };
  if (kpi.projectId) result.projectId = kpi.projectId;
  if (kpi.createdAt) result.createdAt = kpi.createdAt;
  if (kpi.updatedAt) result.updatedAt = kpi.updatedAt;
  return result;
}

function safeLogFailure(logger, reason) {
  try {
    logger.error("KPI mutation service failed.", {
      event: "kpi_mutation_service_failed",
      reason: typeof reason === "string" && SAFE_REASON.test(reason)
        ? reason
        : "UNEXPECTED_ERROR",
    });
  } catch {
    // Logging failure must not replace the safe service error.
  }
}

function transactionFailure(error, logger) {
  if (error instanceof KpiMutationServiceError) {
    if (error.code === "internal") safeLogFailure(logger, error.reason);
    return error;
  }
  const rawCode = typeof error?.code === "string" ? error.code : error?.code;
  if (rawCode === "already-exists" || rawCode === 6) {
    return serviceError("already-exists", "KPI_ALREADY_EXISTS", "The KPI record already exists.");
  }
  if (rawCode === "aborted" || rawCode === 10) {
    return serviceError(
      "aborted",
      "KPI_TRANSACTION_CONFLICT",
      "The KPI changed during this operation. Please try again.",
    );
  }
  safeLogFailure(logger, "KPI_TRANSACTION_FAILED");
  return serviceError("internal", "KPI_TRANSACTION_FAILED", "KPI management is unavailable.");
}

function createKpiMutationService({ firestore, logger, clock }) {
  assertDependencies(firestore, logger, clock);

  return {
    async manageKpi(callerUid, untrustedInput) {
      const uid = normalizeCallerUid(callerUid);
      const input = normalizeOperationInput(untrustedInput);
      const timestamp = input.operation === "delete" ? null : currentTimestamp(clock);
      const collections = {
        authLinks: collectionReference(firestore, "authLinks"),
        employees: collectionReference(firestore, "employees"),
        projects: collectionReference(firestore, "projects"),
        kpis: collectionReference(firestore, "kpis"),
      };
      const kpiReference = input.operation === "create"
        ? documentReference(collections.kpis)
        : documentReference(collections.kpis, input.kpiId);

      try {
        return await firestore.runTransaction(async (transaction) => {
          if (
            !transaction
            || typeof transaction.get !== "function"
            || typeof transaction.create !== "function"
            || typeof transaction.update !== "function"
            || typeof transaction.delete !== "function"
          ) {
            throw serviceError("internal", "INVALID_TRANSACTION", "KPI management is unavailable.");
          }

          const authLinkSnapshot = await transactionGet(
            transaction,
            documentReference(collections.authLinks, uid),
            "AUTH_LINK_READ_FAILED",
          );
          const principalId = resolveAuthLink(authLinkSnapshot);
          const principalSnapshot = await transactionGet(
            transaction,
            documentReference(collections.employees, principalId),
            "PRINCIPAL_READ_FAILED",
          );
          const principal = resolvePrincipal(principalSnapshot, uid, principalId);

          if (input.operation === "create") {
            await authorizeKpi(transaction, collections, principal, input.kpi, "create");
            const record = {
              ...input.kpi,
              rating: null,
              ratedBy: null,
              ratedAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            transaction.create(kpiReference, record);
            return sanitizedKpi(kpiReference.id, record);
          }

          const kpiSnapshot = await transactionGet(transaction, kpiReference, "KPI_READ_FAILED");
          const kpiData = snapshotData(
            kpiSnapshot,
            "not-found",
            "KPI_NOT_FOUND",
            "KPI_DATA_INVALID",
            "The KPI record was not found.",
          );
          const latestKpi = storedKpi(kpiReference.id, kpiData);
          const operationKind = input.operation === "update" ? input.update.kind : "delete";
          await authorizeKpi(transaction, collections, principal, latestKpi, operationKind);

          if (input.operation === "delete") {
            transaction.delete(kpiReference);
            return { id: kpiReference.id, deleted: true };
          }

          if (input.update.kind === "rating") {
            const patch = {
              rating: input.update.values.rating,
              ratedBy: principal.id,
              ratedAt: timestamp,
              updatedAt: timestamp,
            };
            transaction.update(kpiReference, patch);
            return sanitizedKpi(kpiReference.id, { ...latestKpi, ...patch });
          }

          const candidate = { ...latestKpi, ...input.update.values };
          normalizeCoreKpi(candidate);
          const patch = { ...input.update.values, updatedAt: timestamp };
          transaction.update(kpiReference, patch);
          return sanitizedKpi(kpiReference.id, { ...latestKpi, ...patch });
        });
      } catch (error) {
        throw transactionFailure(error, logger);
      }
    },
  };
}

module.exports = {
  KpiMutationServiceError,
  createKpiMutationService,
};
