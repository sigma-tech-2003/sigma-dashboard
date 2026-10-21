import { employeeService } from "./employeeService.js";
import { legacyCodeFor } from "./mutationErrors.js";
import { pollingHub } from "./polling.js";

// Creating an employee (POST /employees). Under Firebase this created a login and sent an invitation; under the
// API the creator sets a TEMPORARY password at creation (D41) and the employee must replace it at first sign-in.
// An admin or hr can later give an existing employee a new temporary password (resetEmployeePassword).
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
  "temporaryPassword",
];

const ERROR_MESSAGES = {
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to create this employee.",
  "invalid-argument": "Review the employee details and try again. The temporary password needs 8 to 200 characters.",
  "already-exists": "An employee account with this email already exists.",
  "failed-precondition": "Your employee profile is not ready for this action.",
  unavailable: "Employee creation is temporarily unavailable. Please try again.",
  internal: "The employee could not be created.",
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

// Giving an existing employee a new temporary password (D41). Its own messages: the refusals here mean different
// things from a failed create.
const RESET_ERROR_MESSAGES = {
  "permission-denied": "You do not have permission to reset this employee's password.",
  "invalid-argument": "Choose a temporary password of 8 to 200 characters.",
  "not-found": "This employee could not be found.",
  unauthenticated: "Your session has expired. Please sign in and try again.",
  unavailable: "The password could not be reset right now. Please try again.",
  internal: "The password could not be reset. Please try again.",
};

/**
 * POST /employees/:id/temporary-password. Only admin and hr may, and only over the roles they manage (hr cannot
 * reset an admin or another hr; nobody resets their own). The employee is forced to replace it at next sign-in and
 * their current sessions end.
 */
export async function resetEmployeePassword(employeeId, temporaryPassword) {
  const invalid = typeof temporaryPassword !== "string" || temporaryPassword.length < 8 || temporaryPassword.length > 200;
  try {
    if (invalid) throw new EmployeeInvitationError("invalid-argument", RESET_ERROR_MESSAGES["invalid-argument"]);
    await employeeService.setTemporaryPassword(employeeId, temporaryPassword);
  } catch (error) {
    if (error instanceof EmployeeInvitationError) throw error;
    const mapped = legacyCodeFor(error);
    const code = Object.hasOwn(RESET_ERROR_MESSAGES, mapped) ? mapped : "internal";
    throw new EmployeeInvitationError(code, RESET_ERROR_MESSAGES[code]);
  }
}

/** Resolves the created employee (page-shaped, with the server's `id`). `profile.temporaryPassword` is required (D41). */
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
