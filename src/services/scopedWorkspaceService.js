import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const PROJECT_TEXT_FIELDS = new Set([
  "title",
  "name",
  "description",
  "department",
  "startDate",
  "dueDate",
  "status",
  "createdAt",
  "updatedAt",
]);
const PROJECT_RELATIONSHIP_FIELDS = new Set(["teamLeadId"]);
const PROJECT_FIELDS = new Set([
  "id",
  ...PROJECT_TEXT_FIELDS,
  ...PROJECT_RELATIONSHIP_FIELDS,
  "assignedEmployeeIds",
]);
const KPI_TEXT_FIELDS = new Set([
  "title",
  "period",
  "status",
  "ratedAt",
  "createdAt",
  "updatedAt",
]);
const KPI_RELATIONSHIP_FIELDS = new Set(["projectId", "empId", "ratedBy"]);
const KPI_NUMBER_FIELDS = new Set(["target", "current", "weight", "rating"]);
const KPI_FIELDS = new Set([
  "id",
  ...KPI_TEXT_FIELDS,
  ...KPI_RELATIONSHIP_FIELDS,
  ...KPI_NUMBER_FIELDS,
]);

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "employee-not-found": "No employee workspace is linked to this account.",
  "inactive-employee": "This employee account is inactive. Contact an administrator.",
  "invalid-role": "This account role cannot access the scoped workspace.",
  "data-integrity": "Employee workspace data requires administrator review.",
  "permission-denied": "You do not have permission to access this workspace.",
  unavailable: "Workspace data is temporarily unavailable. Please try again.",
  "malformed-response": "Workspace data could not be verified.",
  internal: "Workspace data could not be loaded.",
});

const CALLABLE_ERROR_CODES = Object.freeze({
  unauthenticated: "unauthenticated",
  "not-found": "employee-not-found",
  "already-exists": "data-integrity",
  "data-integrity": "data-integrity",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  "network-request-failed": "unavailable",
  cancelled: "unavailable",
  internal: "internal",
});

const INACTIVE_EMPLOYEE_MESSAGE = "This employee account is inactive.";
const INVALID_ROLE_MESSAGE = "This account cannot access the scoped workspace.";
const callableGetScopedWorkspace = httpsCallable(functions, "getScopedWorkspace");

export class ScopedWorkspaceError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "ScopedWorkspaceError";
    this.code = safeCode;
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const malformedResponse = () => new ScopedWorkspaceError("malformed-response");

const normalizedId = (value) => {
  if (typeof value !== "string") throw malformedResponse();
  const id = value.trim();
  if (!id || id.includes("/")) throw malformedResponse();
  return id;
};

const normalizedText = (value) => {
  if (typeof value !== "string") throw malformedResponse();
  return value.trim();
};

const normalizedRelationship = (value) => {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) throw malformedResponse();
    return normalized;
  }
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw malformedResponse();
};

const normalizedNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") throw malformedResponse();
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Number(normalized))) throw malformedResponse();
  return normalized;
};

const sanitizeAssignedEmployeeIds = (value) => {
  if (!Array.isArray(value)) throw malformedResponse();
  return value.map(normalizedRelationship);
};

const assertAllowedFields = (record, fields) => {
  if (Object.keys(record).some((field) => !fields.has(field))) {
    throw malformedResponse();
  }
};

const sanitizeProject = (record) => {
  if (!isPlainObject(record)) throw malformedResponse();
  assertAllowedFields(record, PROJECT_FIELDS);
  if (!Object.prototype.hasOwnProperty.call(record, "assignedEmployeeIds")) {
    throw malformedResponse();
  }

  const project = { id: normalizedId(record.id) };
  for (const [field, value] of Object.entries(record)) {
    if (field === "id") continue;
    if (PROJECT_TEXT_FIELDS.has(field)) project[field] = normalizedText(value);
    else if (PROJECT_RELATIONSHIP_FIELDS.has(field)) {
      project[field] = normalizedRelationship(value);
    } else if (field === "assignedEmployeeIds") {
      project.assignedEmployeeIds = sanitizeAssignedEmployeeIds(value);
    }
  }
  return project;
};

const sanitizeKpi = (record) => {
  if (!isPlainObject(record)) throw malformedResponse();
  assertAllowedFields(record, KPI_FIELDS);

  const kpi = { id: normalizedId(record.id) };
  for (const [field, value] of Object.entries(record)) {
    if (field === "id") continue;
    if (KPI_TEXT_FIELDS.has(field)) kpi[field] = normalizedText(value);
    else if (KPI_RELATIONSHIP_FIELDS.has(field)) {
      kpi[field] = normalizedRelationship(value);
    } else if (KPI_NUMBER_FIELDS.has(field)) {
      kpi[field] = normalizedNumber(value);
    }
  }
  return kpi;
};

const sanitizeRecords = (records, sanitizer) => {
  const ids = new Set();
  return records.map((record) => {
    const sanitized = sanitizer(record);
    if (ids.has(sanitized.id)) throw malformedResponse();
    ids.add(sanitized.id);
    return sanitized;
  });
};

const sanitizeResponse = (value) => {
  if (!isPlainObject(value)) throw malformedResponse();
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "projects")
    || !Object.prototype.hasOwnProperty.call(value, "kpis")
    || !Array.isArray(value.projects)
    || !Array.isArray(value.kpis)
  ) {
    throw malformedResponse();
  }
  return {
    projects: sanitizeRecords(value.projects, sanitizeProject),
    kpis: sanitizeRecords(value.kpis, sanitizeKpi),
  };
};

const rawErrorCode = (error) => {
  try {
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
};

const rawErrorMessage = (error) => {
  try {
    return typeof error?.message === "string" ? error.message : "";
  } catch {
    return "";
  }
};

const normalizedCallableCode = (error) => {
  const rawCode = rawErrorCode(error);
  const separatorIndex = rawCode.lastIndexOf("/");
  const code = separatorIndex >= 0 ? rawCode.slice(separatorIndex + 1) : rawCode;

  if (code === "failed-precondition") {
    return rawErrorMessage(error) === INACTIVE_EMPLOYEE_MESSAGE
      ? "inactive-employee"
      : "data-integrity";
  }
  if (code === "permission-denied") {
    return rawErrorMessage(error) === INVALID_ROLE_MESSAGE
      ? "invalid-role"
      : "permission-denied";
  }
  return CALLABLE_ERROR_CODES[code] || "internal";
};

export async function getScopedWorkspace() {
  try {
    const result = await callableGetScopedWorkspace();
    return sanitizeResponse(result?.data);
  } catch (error) {
    if (error instanceof ScopedWorkspaceError) throw error;
    throw new ScopedWorkspaceError(normalizedCallableCode(error));
  }
}
