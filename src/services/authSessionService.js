import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const VALID_ROLES = new Set(["admin", "hr", "manager", "tl", "employee"]);
const PRINCIPAL_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "dept",
  "pos",
  "joinDate",
  "empId",
  "role",
];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "invalid-argument": "Select a valid role before signing in.",
  "permission-denied": "These credentials do not belong to the selected role.",
  "not-found": "No employee profile is linked to this account.",
  "failed-precondition":
    "This employee account could not be verified. Contact an administrator.",
  "data-integrity":
    "Employee account data could not be verified. Contact an administrator.",
  unavailable: "Employee account verification is temporarily unavailable. Please try again.",
  internal: "Employee account verification could not be completed.",
});

const CALLABLE_ERROR_CODES = Object.freeze({
  unauthenticated: "unauthenticated",
  "invalid-argument": "invalid-argument",
  "permission-denied": "permission-denied",
  "not-found": "not-found",
  "failed-precondition": "failed-precondition",
  "already-exists": "data-integrity",
  "data-integrity": "data-integrity",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  "network-request-failed": "unavailable",
  cancelled: "unavailable",
  internal: "internal",
});

const callableVerifyAuthSession = httpsCallable(functions, "verifyAuthSession");

export class AuthSessionError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "AuthSessionError";
    this.code = safeCode;
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactFields = (value, fields) => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) =>
    Object.prototype.hasOwnProperty.call(value, field));
};

const isValidPrincipal = (value, selectedRole) => {
  if (!isPlainObject(value) || !hasExactFields(value, ["employee", "linkage"])) return false;
  if (value.linkage !== "uid" || !isPlainObject(value.employee)) return false;
  if (!hasExactFields(value.employee, PRINCIPAL_FIELDS)) return false;

  const employee = value.employee;
  const allFieldsAreStrings = PRINCIPAL_FIELDS.every((field) =>
    typeof employee[field] === "string");

  return allFieldsAreStrings
    && Boolean(employee.id.trim())
    && Boolean(employee.name.trim())
    && EMAIL_PATTERN.test(employee.email)
    && VALID_ROLES.has(employee.role)
    && employee.role === selectedRole;
};

const normalizedCallableCode = (error) => {
  let rawCode;
  try {
    rawCode = typeof error?.code === "string" ? error.code : "";
  } catch {
    return "internal";
  }

  const separatorIndex = rawCode.lastIndexOf("/");
  const code = separatorIndex >= 0 ? rawCode.slice(separatorIndex + 1) : rawCode;
  return CALLABLE_ERROR_CODES[code] || "internal";
};

export async function verifyAuthSession(selectedRole) {
  try {
    const result = await callableVerifyAuthSession({ selectedRole });
    const principal = result?.data;

    if (!isValidPrincipal(principal, selectedRole)) {
      throw new AuthSessionError("data-integrity");
    }
    return principal;
  } catch (error) {
    if (error instanceof AuthSessionError) throw error;
    throw new AuthSessionError(normalizedCallableCode(error));
  }
}
