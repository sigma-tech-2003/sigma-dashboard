import { employeeService } from "./employeeService.js";
import { legacyCodeFor } from "./mutationErrors.js";

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
  "replacement-required": "This team lead still has team members. Choose one of them as the new team lead before removing them.",
  "replacement-invalid": "The replacement team lead must be one of this team lead's own members.",
  internal: "Employee management could not be completed.",
});

export class EmployeeMutationError extends Error {
  constructor(code, partialCleanup = null) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "EmployeeMutationError";
    this.code = safeCode;
    // Kept for the page, which reads it; a Postgres delete is one transaction, so there is no partial cleanup.
    if (partialCleanup) this.partialCleanup = Object.freeze({ ...partialCleanup });
  }
}

const failure = (error) => (error instanceof EmployeeMutationError ? error : new EmployeeMutationError(legacyCodeFor(error)));

const requiredId = (value) => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new EmployeeMutationError("invalid-argument");
  return id;
};

/**
 * PATCH /employees/:id. `original` is the employee as the page last read it: with it only the fields that
 * changed are sent, so saving the form does not re-send (and re-authorise) the role or department too.
 */
export async function updateEmployee(employeeDocumentId, updates, { original } = {}) {
  try {
    return await employeeService.update(requiredId(employeeDocumentId), updates, { original });
  } catch (error) {
    throw failure(error);
  }
}

/**
 * DELETE /employees/:id. A team lead who still has members needs `replacementTeamLeadId`, chosen from those
 * members; without it the error is "replacement-required". (The employees page has no control to pick one yet.)
 */
export async function deleteEmployee(employeeDocumentId, { replacementTeamLeadId } = {}) {
  try {
    await employeeService.remove(requiredId(employeeDocumentId), { replacementTeamLeadId });
    return { id: employeeDocumentId, deleted: true };
  } catch (error) {
    throw failure(error);
  }
}
