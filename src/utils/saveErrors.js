// What a page shows when a SAVE fails. Kept free of React so it runs under `node --test`.
//
// The rule it exists for: a save that fails must say so, in words the person can act on, and never leave the screen
// looking as if it worked. A write that is not caught becomes an unhandled promise rejection, the modal stays open and
// nothing explains why. Every page write goes through guardedSave, which turns the failure into a message instead.
//
// Messages come from the API's own error CODE first (the server's wording for some of them names a field, such as
// "manager_employee_id must reference ..."), then from the HTTP status, and only then from the server's text.

const MESSAGES_BY_CODE = Object.freeze({
  invalid_manager: "Choose a manager who already works in this department.",
  name_already_exists: "A department with this name already exists.",
  department_has_employees: "This department still has employees. Move them to another department first.",
  payroll_already_recorded: "Payroll for this employee and month has already been recorded.",
  leave_overlaps: "These dates overlap a leave request you already have (pending or approved).",
  leave_already_decided: "This leave request has already been decided and cannot be changed.",
  self_approval_denied: "You cannot approve or reject your own leave request.",
  leave_scope_denied: "This leave request is outside the people you manage.",
  invalid_request: "Some of the values are not valid. Check the form and try again.",
  invalid_amounts: "The payroll amounts are not valid. Check the bonus and deductions and try again.",
});

const CURATED_ERROR_NAME = /^(Employee|Project|Kpi)(Mutation|Invitation)Error$/;

export const NETWORK_MESSAGE = "Unable to connect. Check your connection and try again.";
export const SERVER_MESSAGE = "The server had a problem and nothing was saved. Please try again.";
export const DEFAULT_SAVE_MESSAGE = "The change could not be saved. Please try again.";

export const LEAVE_DATES_MESSAGE = "End date must be on or after the start date.";

/**
 * The message for a leave request whose dates cannot be right, or "" when they can be. Checked before anything is sent,
 * so the common mistake is explained straight away instead of coming back as a vague 400. Dates are YYYY-MM-DD, which
 * compare correctly as text; an empty date is the form's own "required" problem, not this one.
 */
export function leaveDatesError(start, end) {
  if (!start || !end) return "";
  return end < start ? LEAVE_DATES_MESSAGE : "";
}

/**
 * A sentence that is safe to show for a failed save.
 * @param {unknown} error whatever the write threw
 * @param {string} [fallback] used when nothing more specific is known
 */
export function describeSaveError(error, fallback = DEFAULT_SAVE_MESSAGE) {
  // The employee, project and KPI services wrap API failures in their own error classes. Their messages come from
  // fixed tables in those modules (never from the server), so they are already safe and worded for a person.
  if (CURATED_ERROR_NAME.test(error?.name ?? "") && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  // Anything else that is not an API answer (a mapping error, a stray TypeError) never reaches the screen as raw text.
  if (error?.name !== "ApiError") return fallback;

  if (Object.hasOwn(MESSAGES_BY_CODE, error.code)) return MESSAGES_BY_CODE[error.code];
  if (error.status === 0) return NETWORK_MESSAGE;
  if (error.status >= 500) return SERVER_MESSAGE;
  if (error.status === 401) return "Your session has expired. Please sign in again.";
  if (error.status === 403) return "You do not have permission to do this.";
  if (error.status === 404) return "This record no longer exists. Refresh the page and try again.";
  if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return fallback;
}

/**
 * Runs a write and never throws. Resolves `{ ok: true, value }`, or `{ ok: false, message }` for the page to show.
 * @param {() => Promise<unknown>} action
 * @param {{ fallback?: string }} [options]
 */
export async function guardedSave(action, { fallback } = {}) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, message: describeSaveError(error, fallback) };
  }
}
