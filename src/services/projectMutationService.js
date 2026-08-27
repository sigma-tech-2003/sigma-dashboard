import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

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
const PROJECT_RESPONSE_FIELDS = new Set([
  "id",
  ...PROJECT_INPUT_FIELDS,
  "createdAt",
  "updatedAt",
]);
const PROJECT_STATUSES = new Set(["draft", "active", "completed"]);

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to manage this project.",
  "invalid-argument": "Review the project details and try again.",
  "not-found": "This project or a referenced employee could not be found.",
  "already-exists": "This project conflicts with an existing record.",
  "failed-precondition": "The project could not be verified in its current state.",
  aborted: "The project changed during this operation. Please try again.",
  unavailable: "Project management is temporarily unavailable. Please try again.",
  "malformed-response": "The project response could not be verified.",
  internal: "Project management could not be completed.",
});

const CALLABLE_CODE_MAP = Object.freeze({
  unauthenticated: "unauthenticated",
  "permission-denied": "permission-denied",
  "invalid-argument": "invalid-argument",
  "not-found": "not-found",
  "already-exists": "already-exists",
  "failed-precondition": "failed-precondition",
  aborted: "aborted",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  "network-request-failed": "unavailable",
  cancelled: "unavailable",
  internal: "internal",
});

const callableManageProject = httpsCallable(functions, "manageProject");

export class ProjectMutationError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "ProjectMutationError";
    this.code = safeCode;
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalidProject = () => new ProjectMutationError("invalid-argument");
const malformedResponse = () => new ProjectMutationError("malformed-response");

const normalizedId = (value, errorFactory = invalidProject) => {
  let id = "";
  if (typeof value === "string") id = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) id = String(value);
  if (!id || id.includes("/") || id === "." || id === "..") throw errorFactory();
  return id;
};

const normalizedText = (value, { required = true } = {}) => {
  if (typeof value !== "string") throw invalidProject();
  const text = value.trim();
  if (required && !text) throw invalidProject();
  return text;
};

const normalizedDate = (value) => {
  const date = normalizedText(value);
  if (Number.isNaN(Date.parse(date))) throw invalidProject();
  return date;
};

const normalizedTeamLeadId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return normalizedId(value);
};

const normalizedAssignments = (value) => {
  if (!Array.isArray(value) || value.length === 0) throw invalidProject();
  const assignments = value.map((id) => normalizedId(id));
  if (new Set(assignments).size !== assignments.length) throw invalidProject();
  return assignments;
};

const projectPayload = (project) => {
  if (!isPlainObject(project)) throw invalidProject();
  const startDate = normalizedDate(project.startDate);
  const dueDate = normalizedDate(project.dueDate);
  if (Date.parse(dueDate) < Date.parse(startDate)) throw invalidProject();
  const status = typeof project.status === "string" ? project.status.trim() : "";
  if (!PROJECT_STATUSES.has(status)) throw invalidProject();

  return {
    title: normalizedText(project.title),
    description: normalizedText(project.description, { required: false }),
    department: normalizedText(project.department),
    teamLeadId: normalizedTeamLeadId(project.teamLeadId),
    assignedEmployeeIds: normalizedAssignments(project.assignedEmployeeIds),
    startDate,
    dueDate,
    status,
  };
};

const sanitizedProjectResponse = (value) => {
  if (!isPlainObject(value)) throw malformedResponse();
  const keys = Object.keys(value);
  if (
    keys.length !== PROJECT_RESPONSE_FIELDS.size
    || keys.some((field) => !PROJECT_RESPONSE_FIELDS.has(field))
  ) {
    throw malformedResponse();
  }

  let project;
  try {
    project = projectPayload(value);
  } catch {
    throw malformedResponse();
  }
  const id = normalizedId(value.id, malformedResponse);
  if (
    typeof value.createdAt !== "string"
    || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.updatedAt !== "string"
    || Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw malformedResponse();
  }
  return {
    id,
    ...project,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const sanitizedDeleteResponse = (value, projectId) => {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 2
    || value.deleted !== true
    || normalizedId(value.id, malformedResponse) !== projectId
  ) {
    throw malformedResponse();
  }
  return { id: projectId, deleted: true };
};

const normalizedCallableCode = (error) => {
  const rawCode = (() => {
    try {
      return typeof error?.code === "string" ? error.code : "";
    } catch {
      return "";
    }
  })();
  const separatorIndex = rawCode.lastIndexOf("/");
  const code = separatorIndex >= 0 ? rawCode.slice(separatorIndex + 1) : rawCode;
  return CALLABLE_CODE_MAP[code] || "internal";
};

const invokeProjectMutation = async (payload, responseSanitizer) => {
  try {
    const result = await callableManageProject(payload);
    return responseSanitizer(result?.data);
  } catch (error) {
    if (error instanceof ProjectMutationError) throw error;
    throw new ProjectMutationError(normalizedCallableCode(error));
  }
};

export function createProject(project) {
  return invokeProjectMutation(
    { operation: "create", project: projectPayload(project) },
    sanitizedProjectResponse,
  );
}

export function updateProject(projectId, updates) {
  const id = normalizedId(projectId);
  return invokeProjectMutation(
    { operation: "update", projectId: id, project: projectPayload(updates) },
    (response) => {
      const project = sanitizedProjectResponse(response);
      if (project.id !== id) throw malformedResponse();
      return project;
    },
  );
}

export function deleteProject(projectId) {
  const id = normalizedId(projectId);
  return invokeProjectMutation(
    { operation: "delete", projectId: id },
    (response) => sanitizedDeleteResponse(response, id),
  );
}
