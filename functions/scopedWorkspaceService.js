/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_QUERY_VALUES = 30;
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];
const PROJECT_FIELDS = [
  "title",
  "name",
  "description",
  "department",
  "teamLeadId",
  "assignedEmployeeIds",
  "startDate",
  "dueDate",
  "status",
  "createdAt",
  "updatedAt",
];
const KPI_FIELDS = [
  "projectId",
  "empId",
  "title",
  "target",
  "current",
  "weight",
  "period",
  "status",
  "rating",
  "ratedBy",
  "ratedAt",
  "createdAt",
  "updatedAt",
];
const PROJECT_TEXT_FIELDS = [
  "title",
  "name",
  "description",
  "department",
  "startDate",
  "dueDate",
  "status",
  "createdAt",
  "updatedAt",
];
const KPI_TEXT_FIELDS = [
  "title",
  "period",
  "status",
  "ratedAt",
  "createdAt",
  "updatedAt",
];
const KPI_NUMBER_FIELDS = ["target", "current", "weight", "rating"];

class ScopedWorkspaceServiceError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = "ScopedWorkspaceServiceError";
    this.code = code;
    this.reason = reason;
  }
}

function serviceError(code, reason, message) {
  return new ScopedWorkspaceServiceError(code, reason, message);
}

function assertDependencies(firestore, logger) {
  const validFirestore = firestore && typeof firestore.collection === "function";
  const validLogger = logger && typeof logger.error === "function";
  if (!validFirestore || !validLogger) {
    throw serviceError(
      "failed-precondition",
      "INVALID_SERVICE_CONFIGURATION",
      "Scoped workspace service is not configured.",
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
  if (
    !uid
    || uid.length > MAX_FIREBASE_UID_LENGTH
    || hasInvalidUidCharacters(uid)
  ) {
    throw serviceError(
      "unauthenticated",
      "INVALID_AUTH_IDENTITY",
      "Authentication is required.",
    );
  }
  return uid;
}

function normalizeDocumentId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.includes("/")) return null;
  return normalized;
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function collectionReference(firestore, collectionName) {
  try {
    const reference = firestore.collection(collectionName);
    if (!reference || typeof reference.doc !== "function" || typeof reference.where !== "function") {
      throw new Error("invalid collection reference");
    }
    return reference;
  } catch {
    throw serviceError(
      "internal",
      "COLLECTION_REFERENCE_FAILED",
      "Scoped workspace data is unavailable.",
    );
  }
}

function documentReference(collection, documentId) {
  try {
    const reference = collection.doc(documentId);
    if (!reference || typeof reference.get !== "function") {
      throw new Error("invalid document reference");
    }
    return reference;
  } catch {
    throw serviceError(
      "internal",
      "DOCUMENT_REFERENCE_FAILED",
      "Scoped workspace data is unavailable.",
    );
  }
}

async function readDocument(reference, failureReason) {
  try {
    return await reference.get();
  } catch (error) {
    if (error instanceof ScopedWorkspaceServiceError) throw error;
    throw serviceError(
      "internal",
      failureReason,
      "Scoped workspace data is unavailable.",
    );
  }
}

function snapshotData(snapshot, missingReason, invalidReason) {
  if (!snapshot || snapshot.exists !== true) {
    throw serviceError("not-found", missingReason, "Employee workspace was not found.");
  }
  if (typeof snapshot.data !== "function") {
    throw serviceError(
      "failed-precondition",
      invalidReason,
      "Employee workspace data is invalid.",
    );
  }
  const data = snapshot.data();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw serviceError(
      "failed-precondition",
      invalidReason,
      "Employee workspace data is invalid.",
    );
  }
  return data;
}

function resolveAuthLink(snapshot) {
  const data = snapshotData(snapshot, "AUTH_LINK_MISSING", "AUTH_LINK_CONFLICT");
  const exactShape = Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(data, field));
  const employeeId = exactShape ? normalizeDocumentId(data.employeeId) : null;
  if (!employeeId || !isTimestamp(data.createdAt) || !isTimestamp(data.updatedAt)) {
    throw serviceError(
      "failed-precondition",
      "AUTH_LINK_CONFLICT",
      "Employee workspace linkage is invalid.",
    );
  }
  return employeeId;
}

function resolvePrincipal(snapshot, callerUid, employeeId) {
  const data = snapshotData(snapshot, "EMPLOYEE_NOT_FOUND", "DATA_INTEGRITY_FAILURE");
  const employeeUid = typeof data.uid === "string" ? data.uid.trim() : "";
  if (employeeUid !== callerUid) {
    throw serviceError(
      "failed-precondition",
      "EMPLOYEE_UID_MISMATCH",
      "Employee workspace identity is invalid.",
    );
  }
  if (typeof data.status !== "string" || data.status.trim().toLowerCase() !== "active") {
    throw serviceError(
      "failed-precondition",
      "EMPLOYEE_INACTIVE",
      "This employee account is inactive.",
    );
  }
  if (!new Set(["manager", "tl"]).has(data.role)) {
    throw serviceError(
      "permission-denied",
      "ROLE_NOT_ALLOWED",
      "This account cannot access the scoped workspace.",
    );
  }
  const department = typeof data.dept === "string" ? data.dept.trim() : "";
  if (data.role === "manager" && !department) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_SCOPE_INVALID",
      "The manager workspace scope is invalid.",
    );
  }
  return { id: employeeId, role: data.role, department };
}

function safeLogFailure(logger, reason) {
  try {
    logger.error("Scoped workspace service failed.", {
      event: "scoped_workspace_service_failed",
      reason: typeof reason === "string" && /^[A-Z0-9_]{1,64}$/.test(reason)
        ? reason
        : "UNEXPECTED_ERROR",
    });
  } catch {
    // Logging failure must never replace the safe service error.
  }
}

function relationshipVariants(value) {
  const id = normalizeDocumentId(value);
  if (!id) return [];
  const variants = [id];
  if (/^(0|[1-9]\d*)$/.test(id)) {
    const numericId = Number(id);
    if (Number.isSafeInteger(numericId) && String(numericId) === id) {
      variants.push(numericId);
    }
  }
  return variants;
}

function deduplicateValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relationshipValues(documentIds) {
  const normalizedIds = [...new Set(documentIds.map(normalizeDocumentId).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return deduplicateValues(normalizedIds.flatMap(relationshipVariants));
}

function chunks(values) {
  const result = [];
  for (let index = 0; index < values.length; index += MAX_QUERY_VALUES) {
    result.push(values.slice(index, index + MAX_QUERY_VALUES));
  }
  return result;
}

function snapshotDocuments(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.docs)) {
    throw serviceError(
      "internal",
      "INVALID_DATA_RESPONSE",
      "Scoped workspace data is unavailable.",
    );
  }
  return snapshot.docs.map((document) => {
    const id = normalizeDocumentId(document?.id);
    if (!id || typeof document.data !== "function") {
      throw serviceError(
        "internal",
        "INVALID_DATA_RESPONSE",
        "Scoped workspace data is unavailable.",
      );
    }
    const data = document.data();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw serviceError(
        "internal",
        "INVALID_DATA_RESPONSE",
        "Scoped workspace data is unavailable.",
      );
    }
    return { id, data };
  });
}

async function constrainedQuery({
  collection,
  field,
  operator,
  value,
  selectedFields,
}) {
  try {
    let query = collection.where(field, operator, value);
    if (!query || typeof query.select !== "function") {
      throw new Error("invalid query");
    }
    query = query.select(...selectedFields);
    if (!query || typeof query.get !== "function") throw new Error("invalid query");
    return snapshotDocuments(await query.get());
  } catch (error) {
    if (error instanceof ScopedWorkspaceServiceError) throw error;
    throw serviceError(
      "internal",
      "SCOPED_QUERY_FAILED",
      "Scoped workspace data is unavailable.",
    );
  }
}

async function chunkedQueries({
  collection,
  field,
  operator,
  values,
  selectedFields,
}) {
  if (values.length === 0) return [];
  const results = await Promise.all(chunks(values).map((valueChunk) => constrainedQuery({
    collection,
    field,
    operator,
    value: valueChunk,
    selectedFields,
  })));
  return results.flat();
}

function deduplicateDocuments(documents) {
  const byId = new Map();
  documents.forEach((document) => byId.set(document.id, document));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : null;
}

function safeRelationship(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

function copyTextFields(target, data, fields) {
  fields.forEach((field) => {
    const value = safeText(data[field]);
    if (value !== null) target[field] = value;
  });
}

function sanitizeProject(document) {
  const project = { id: document.id };
  copyTextFields(project, document.data, PROJECT_TEXT_FIELDS);
  const teamLeadId = safeRelationship(document.data.teamLeadId);
  if (teamLeadId !== null) project.teamLeadId = teamLeadId;
  const assignedEmployeeIds = Array.isArray(document.data.assignedEmployeeIds)
    ? deduplicateValues(document.data.assignedEmployeeIds
      .map(safeRelationship)
      .filter((value) => value !== null))
    : [];
  project.assignedEmployeeIds = assignedEmployeeIds;
  return project;
}

function safeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Number(normalized))) return null;
  return normalized;
}

function sanitizeKpi(document) {
  const kpi = { id: document.id };
  copyTextFields(kpi, document.data, KPI_TEXT_FIELDS);
  for (const field of ["projectId", "empId", "ratedBy"]) {
    const value = safeRelationship(document.data[field]);
    if (value !== null) kpi[field] = value;
  }
  KPI_NUMBER_FIELDS.forEach((field) => {
    const value = safeNumber(document.data[field]);
    if (value !== null) kpi[field] = value;
  });
  return kpi;
}

function hasProjectId(data) {
  if (data.projectId === undefined || data.projectId === null) return false;
  if (typeof data.projectId === "string") return data.projectId.trim() !== "";
  return true;
}

async function managerScope({ firestore, principal }) {
  const projects = collectionReference(firestore, "projects");
  const employees = collectionReference(firestore, "employees");
  const [projectDocuments, employeeDocuments] = await Promise.all([
    constrainedQuery({
      collection: projects,
      field: "department",
      operator: "==",
      value: principal.department,
      selectedFields: PROJECT_FIELDS,
    }),
    constrainedQuery({
      collection: employees,
      field: "dept",
      operator: "==",
      value: principal.department,
      selectedFields: ["dept"],
    }),
  ]);
  return {
    projectDocuments: deduplicateDocuments(projectDocuments),
    legacyEmployeeIds: employeeDocuments.map((document) => document.id),
  };
}

async function teamLeadScope({ firestore, principal }) {
  const employees = collectionReference(firestore, "employees");
  const projects = collectionReference(firestore, "projects");
  const teamLeadIds = relationshipVariants(principal.id);
  const teamMembers = await chunkedQueries({
    collection: employees,
    field: "teamLeadId",
    operator: "in",
    values: teamLeadIds,
    selectedFields: ["teamLeadId"],
  });
  const teamMemberIds = deduplicateDocuments(teamMembers).map((document) => document.id);
  const teamMemberRelationshipIds = relationshipValues(teamMemberIds);
  const [directProjects, assignedProjects] = await Promise.all([
    chunkedQueries({
      collection: projects,
      field: "teamLeadId",
      operator: "in",
      values: teamLeadIds,
      selectedFields: PROJECT_FIELDS,
    }),
    chunkedQueries({
      collection: projects,
      field: "assignedEmployeeIds",
      operator: "array-contains-any",
      values: teamMemberRelationshipIds,
      selectedFields: PROJECT_FIELDS,
    }),
  ]);
  return {
    projectDocuments: deduplicateDocuments([...directProjects, ...assignedProjects]),
    legacyEmployeeIds: [principal.id, ...teamMemberIds],
  };
}

async function kpiScope({ firestore, projectDocuments, legacyEmployeeIds }) {
  const kpis = collectionReference(firestore, "kpis");
  const projectIds = relationshipValues(projectDocuments.map((document) => document.id));
  const employeeIds = relationshipValues(legacyEmployeeIds);
  const [projectKpis, employeeKpiCandidates] = await Promise.all([
    chunkedQueries({
      collection: kpis,
      field: "projectId",
      operator: "in",
      values: projectIds,
      selectedFields: KPI_FIELDS,
    }),
    chunkedQueries({
      collection: kpis,
      field: "empId",
      operator: "in",
      values: employeeIds,
      selectedFields: KPI_FIELDS,
    }),
  ]);
  const legacyKpis = employeeKpiCandidates.filter((document) => !hasProjectId(document.data));
  return deduplicateDocuments([...projectKpis, ...legacyKpis]);
}

async function loadScopedWorkspace({ firestore, logger, callerUid }) {
  try {
    const uid = normalizeCallerUid(callerUid);
    const authLinks = collectionReference(firestore, "authLinks");
    const authLinkSnapshot = await readDocument(
      documentReference(authLinks, uid),
      "AUTH_LINK_READ_FAILED",
    );
    const employeeId = resolveAuthLink(authLinkSnapshot);
    const employees = collectionReference(firestore, "employees");
    const employeeSnapshot = await readDocument(
      documentReference(employees, employeeId),
      "EMPLOYEE_READ_FAILED",
    );
    const principal = resolvePrincipal(employeeSnapshot, uid, employeeId);
    const scope = principal.role === "manager"
      ? await managerScope({ firestore, principal })
      : await teamLeadScope({ firestore, principal });
    const kpiDocuments = await kpiScope({ firestore, ...scope });

    return {
      projects: scope.projectDocuments.map(sanitizeProject),
      kpis: kpiDocuments.map(sanitizeKpi),
    };
  } catch (error) {
    if (error instanceof ScopedWorkspaceServiceError) {
      if (error.code === "internal") safeLogFailure(logger, error.reason);
      throw error;
    }
    safeLogFailure(logger, "UNEXPECTED_ERROR");
    throw serviceError(
      "internal",
      "UNEXPECTED_ERROR",
      "Scoped workspace data is unavailable.",
    );
  }
}

function createScopedWorkspaceService({ firestore, logger }) {
  assertDependencies(firestore, logger);
  return {
    getScopedWorkspace(callerUid) {
      return loadScopedWorkspace({ firestore, logger, callerUid });
    },
  };
}

module.exports = {
  ScopedWorkspaceServiceError,
  createScopedWorkspaceService,
};
