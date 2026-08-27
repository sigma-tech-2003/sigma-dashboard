import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const PROFILE_FIELDS = [
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

const ERROR_MESSAGES = {
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to create this employee.",
  "invalid-argument": "Review the employee details and try again.",
  "already-exists": "An employee account with this email already exists.",
  "failed-precondition": "Your employee profile is not ready for this action.",
  unavailable: "Employee invitations are temporarily unavailable. Please try again.",
  internal: "Employee invitation could not be completed.",
};

const callableInviteEmployee = httpsCallable(functions, "inviteEmployee");

export class EmployeeInvitationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmployeeInvitationError";
    this.code = code;
  }
}

function invalidProfileError() {
  return new EmployeeInvitationError(
    "invalid-argument",
    ERROR_MESSAGES["invalid-argument"],
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function profilePayload(profile) {
  if (!isPlainObject(profile)) throw invalidProfileError();

  const suppliedFields = Object.keys(profile);
  if (suppliedFields.some((field) => !PROFILE_FIELDS.includes(field))) {
    throw invalidProfileError();
  }

  return PROFILE_FIELDS.reduce((payload, field) => {
    if (Object.prototype.hasOwnProperty.call(profile, field)) {
      payload[field] = profile[field];
    }
    return payload;
  }, {});
}

function normalizedCallableCode(error) {
  let rawCode;
  try {
    rawCode = typeof error?.code === "string" ? error.code : "";
  } catch {
    return "internal";
  }

  const code = rawCode.startsWith("functions/")
    ? rawCode.slice("functions/".length)
    : rawCode;
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? code : "internal";
}

function safeInvitationError(error) {
  const code = normalizedCallableCode(error);
  return new EmployeeInvitationError(code, ERROR_MESSAGES[code]);
}

export async function inviteEmployee(profile) {
  try {
    const result = await callableInviteEmployee(profilePayload(profile));
    return result.data;
  } catch (error) {
    if (error instanceof EmployeeInvitationError) throw error;
    throw safeInvitationError(error);
  }
}
