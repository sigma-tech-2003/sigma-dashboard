import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const EDITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "dept",
  "pos",
  "basic",
  "allowances",
  "joinDate",
  "role",
  "status",
  "teamLeadId",
];
const EMPLOYEE_RESPONSE_FIELDS = new Set([
  "id",
  ...EDITABLE_FIELDS,
  "empId",
  "createdAt",
  "updatedAt",
]);
const REQUIRED_EMPLOYEE_RESPONSE_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "dept",
  "pos",
  "basic",
  "allowances",
  "joinDate",
  "role",
  "status",
  "empId",
  "createdAt",
  "updatedAt",
];
const ROLES = new Set(["admin", "hr", "manager", "tl", "employee"]);
const STATUSES = new Set(["active", "inactive"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to manage this employee.",
  "invalid-argument": "Review the employee details and try again.",
  "not-found": "This employee record could not be found.",
  "already-exists": "This employee email is already in use.",
  "failed-precondition": "The employee record could not be verified in its current state.",
  aborted: "The employee changed during this operation. Please try again.",
  unavailable: "Employee management is temporarily unavailable. Please try again.",
  "malformed-response": "The employee response could not be verified.",
  "cleanup-pending": "Employee access was revoked, but final account cleanup is still pending.",
  "identity-cleanup-pending": "The employee was not updated and identity cleanup is still pending.",
  "invitation-required": "Employee creation must use the secure invitation flow.",
  internal: "Employee management could not be completed.",
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

const callableManageEmployee = httpsCallable(functions, "manageEmployee");

export class EmployeeMutationError extends Error {
  constructor(code, partialCleanup = null) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "EmployeeMutationError";
    this.code = safeCode;
    if (partialCleanup) this.partialCleanup = Object.freeze({ ...partialCleanup });
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalidArgument = () => new EmployeeMutationError("invalid-argument");
const malformedResponse = () => new EmployeeMutationError("malformed-response");

const normalizedDocumentId = (value, errorFactory = invalidArgument) => {
  const id = typeof value === "string" ? value.trim() : "";
  if (
    !id
    || id !== value
    || id.includes("/")
    || id === "."
    || id === ".."
    || [...id].some((character) => character.codePointAt(0) < 32)
  ) {
    throw errorFactory();
  }
  return id;
};

const normalizedRequiredText = (value, errorFactory = invalidArgument) => {
  if (typeof value !== "string") throw errorFactory();
  const text = value.trim();
  if (!text) throw errorFactory();
  return text;
};

const normalizedOptionalText = (value, errorFactory = invalidArgument) => {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw errorFactory();
  return value.trim();
};

const normalizedEmail = (value, errorFactory = invalidArgument) => {
  const email = normalizedRequiredText(value, errorFactory).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw errorFactory();
  return email;
};

const normalizedNumber = (value, errorFactory = invalidArgument) => {
  if ((typeof value !== "number" && typeof value !== "string")
      || (typeof value === "string" && value.trim() === "")) {
    throw errorFactory();
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw errorFactory();
  return number;
};

const normalizedDate = (value, errorFactory = invalidArgument) => {
  const date = normalizedRequiredText(value, errorFactory);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw errorFactory();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw errorFactory();
  }
  return date;
};

const normalizedRole = (value, errorFactory = invalidArgument) => {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ROLES.has(role)) throw errorFactory();
  return role;
};

const normalizedStatus = (value, errorFactory = invalidArgument) => {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!STATUSES.has(status)) throw errorFactory();
  return status;
};

const normalizedTeamLeadId = (value, errorFactory = invalidArgument) => {
  if (value == null || value === "") return null;
  if (typeof value === "string") return normalizedDocumentId(value.trim(), errorFactory);
  if (Number.isSafeInteger(value) && value >= 0) {
    return normalizedDocumentId(String(value), errorFactory);
  }
  throw errorFactory();
};

const sanitizedUpdatePayload = (updates) => {
  if (!isPlainObject(updates)) throw invalidArgument();
  const payload = {};
  EDITABLE_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(updates, field) || updates[field] === undefined) return;
    const value = updates[field];
    if (field === "name" || field === "dept" || field === "pos") {
      payload[field] = normalizedRequiredText(value);
    } else if (field === "email") payload.email = normalizedEmail(value);
    else if (field === "phone") payload.phone = normalizedOptionalText(value);
    else if (field === "basic" || field === "allowances") payload[field] = normalizedNumber(value);
    else if (field === "joinDate") payload.joinDate = normalizedDate(value);
    else if (field === "role") payload.role = normalizedRole(value);
    else if (field === "status") payload.status = normalizedStatus(value);
    else if (field === "teamLeadId") payload.teamLeadId = normalizedTeamLeadId(value);
  });
  if (Object.keys(payload).length === 0) throw invalidArgument();
  return payload;
};

const sanitizedEmployeeResponse = (value, expectedId) => {
  if (!isPlainObject(value)) throw malformedResponse();
  const keys = Object.keys(value);
  if (
    keys.some((field) => !EMPLOYEE_RESPONSE_FIELDS.has(field))
    || REQUIRED_EMPLOYEE_RESPONSE_FIELDS.some((field) =>
      !Object.prototype.hasOwnProperty.call(value, field))
  ) {
    throw malformedResponse();
  }
  const responseError = malformedResponse;
  const id = normalizedDocumentId(value.id, responseError);
  if (id !== expectedId) throw malformedResponse();
  const createdAt = value.createdAt === null
    ? null
    : normalizedRequiredText(value.createdAt, responseError);
  if (
    (createdAt !== null && Number.isNaN(Date.parse(createdAt)))
    || typeof value.updatedAt !== "string"
    || Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw malformedResponse();
  }
  const employee = {
    id,
    name: normalizedRequiredText(value.name, responseError),
    email: normalizedEmail(value.email, responseError),
    phone: normalizedOptionalText(value.phone, responseError),
    dept: normalizedRequiredText(value.dept, responseError),
    pos: normalizedRequiredText(value.pos, responseError),
    basic: normalizedNumber(value.basic, responseError),
    allowances: normalizedNumber(value.allowances, responseError),
    joinDate: normalizedDate(value.joinDate, responseError),
    role: normalizedRole(value.role, responseError),
    status: normalizedStatus(value.status, responseError),
    empId: normalizedOptionalText(value.empId, responseError),
    createdAt,
    updatedAt: value.updatedAt,
  };
  if (Object.prototype.hasOwnProperty.call(value, "teamLeadId")) {
    const teamLeadId = normalizedTeamLeadId(value.teamLeadId, responseError);
    if (teamLeadId === null) throw malformedResponse();
    employee.teamLeadId = teamLeadId;
  }
  return employee;
};

const sanitizedDeleteResponse = (value, expectedId) => {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 3
    || value.deleted !== true
    || typeof value.authAccountDeleted !== "boolean"
    || normalizedDocumentId(value.employeeId, malformedResponse) !== expectedId
  ) {
    throw malformedResponse();
  }
  return {
    employeeId: expectedId,
    deleted: true,
    authAccountDeleted: value.authAccountDeleted,
  };
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

const safePartialCleanup = (error, expectedId) => {
  let partialResult;
  try {
    partialResult = error?.details?.partialResult;
  } catch {
    return null;
  }
  if (!isPlainObject(partialResult)) return null;
  let employeeId;
  try {
    employeeId = normalizedDocumentId(partialResult.employeeId, malformedResponse);
  } catch {
    return null;
  }
  if (employeeId !== expectedId) return null;
  if (
    partialResult.accessRevoked === true
    && partialResult.cleanupPending === true
    && Object.keys(partialResult).length === 3
  ) {
    return { kind: "delete", employeeId, accessRevoked: true, cleanupPending: true };
  }
  if (
    partialResult.firestoreUpdated === false
    && partialResult.authCleanupPending === true
    && Object.keys(partialResult).length === 3
  ) {
    return {
      kind: "update",
      employeeId,
      firestoreUpdated: false,
      authCleanupPending: true,
    };
  }
  return null;
};

const invokeEmployeeMutation = async (payload, expectedId, responseSanitizer) => {
  try {
    const result = await callableManageEmployee(payload);
    return responseSanitizer(result?.data, expectedId);
  } catch (error) {
    if (error instanceof EmployeeMutationError) throw error;
    const partialCleanup = safePartialCleanup(error, expectedId);
    if (partialCleanup?.kind === "delete") {
      throw new EmployeeMutationError("cleanup-pending", partialCleanup);
    }
    if (partialCleanup?.kind === "update") {
      throw new EmployeeMutationError("identity-cleanup-pending", partialCleanup);
    }
    throw new EmployeeMutationError(normalizedCallableCode(error));
  }
};

export function updateEmployee(employeeDocumentId, updates) {
  const id = normalizedDocumentId(employeeDocumentId);
  return invokeEmployeeMutation(
    { operation: "update", employeeId: id, updates: sanitizedUpdatePayload(updates) },
    id,
    sanitizedEmployeeResponse,
  );
}

export function deleteEmployee(employeeDocumentId) {
  const id = normalizedDocumentId(employeeDocumentId);
  return invokeEmployeeMutation(
    { operation: "delete", employeeId: id },
    id,
    sanitizedDeleteResponse,
  );
}
