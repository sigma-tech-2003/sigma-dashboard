import { employeeService } from "./employeeService.js";
import { legacyCodeFor } from "./mutationErrors.js";
import { pollingHub } from "./polling.js";

// Creating an employee (POST /employees). Under Firebase this created a login and sent an invitation; under the
// API it creates the employee and a user in the `invited` state with no password (D25), and a later step (an
// admin or hr issuing a setup link, D34) lets the person set one.
//
// `status` may be "active" or "inactive" (D35): an inactive employee is created in a disabled state.

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

export class EmployeeInvitationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmployeeInvitationError";
    this.code = code;
  }
}

function invalidProfileError() {
  return new EmployeeInvitationError("invalid-argument", ERROR_MESSAGES["invalid-argument"]);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function profilePayload(profile) {
  if (!isPlainObject(profile)) throw invalidProfileError();
  if (Object.keys(profile).some((field) => !PROFILE_FIELDS.includes(field))) throw invalidProfileError();

  return PROFILE_FIELDS.reduce((payload, field) => {
    if (Object.hasOwn(profile, field)) payload[field] = profile[field];
    return payload;
  }, {});
}

function safeInvitationError(error) {
  const mapped = legacyCodeFor(error);
  const code = Object.hasOwn(ERROR_MESSAGES, mapped) ? mapped : "internal";
  return new EmployeeInvitationError(code, ERROR_MESSAGES[code]);
}

/** Resolves the created employee (page-shaped, with the server's `id` and the `email` to send the setup link to). */
export async function inviteEmployee(profile) {
  try {
    const created = await employeeService.create(profilePayload(profile));
    // EmployeesPage calls this directly, not through a data hook, so nothing would re-poll for it: do it here,
    // or the new employee would not appear for up to a poll interval.
    pollingHub.pollAllNow().catch(() => {});
    return created;
  } catch (error) {
    if (error instanceof EmployeeInvitationError) throw error;
    throw safeInvitationError(error);
  }
}
