import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "not-found": "No employee profile is available for this account.",
  "failed-precondition": "This employee account cannot be linked automatically.",
  "data-integrity": "Employee account linkage requires administrator review.",
  unavailable: "Employee account linking is temporarily unavailable. Please try again.",
  internal: "Employee account linking could not be completed.",
});

const CALLABLE_ERROR_CODES = Object.freeze({
  unauthenticated: "unauthenticated",
  "not-found": "not-found",
  "failed-precondition": "failed-precondition",
  "already-exists": "data-integrity",
  "data-integrity": "data-integrity",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  "network-request-failed": "unavailable",
  cancelled: "unavailable",
});

const callableLinkLegacyEmployeeUid = httpsCallable(
  functions,
  "linkLegacyEmployeeUid",
);

export class LegacyEmployeeLinkError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "LegacyEmployeeLinkError";
    this.code = safeCode;
  }
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
  return CALLABLE_ERROR_CODES[code] || "internal";
}

export async function linkLegacyEmployeeUid() {
  try {
    const result = await callableLinkLegacyEmployeeUid();
    return result.data;
  } catch (error) {
    throw new LegacyEmployeeLinkError(normalizedCallableCode(error));
  }
}
