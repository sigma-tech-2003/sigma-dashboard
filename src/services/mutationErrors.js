// Turns an ApiError (or a MappingError) into the short codes the pages' error classes already use
// (EmployeeMutationError, ProjectMutationError, KpiMutationError, EmployeeInvitationError), so the messages
// the pages show are the ones they showed under Firebase.
//
// This is deliberately coarse: the pages render a single sentence per code. The server's own code and message
// are not shown, so internal detail never reaches the screen.

const ALREADY_EXISTS_CODES = new Set(["email_already_exists", "name_already_exists", "conflict", "attendance_already_recorded", "payroll_already_recorded", "leave_overlaps"]);

export function legacyCodeFor(error) {
  if (error?.name === "MappingError") return "invalid-argument";
  if (error?.name !== "ApiError") return "internal";

  // Specific rules the UI can eventually act on, kept distinct from the generic buckets below.
  if (error.code === "team_lead_replacement_required") return "replacement-required";
  if (error.code === "team_lead_replacement_invalid") return "replacement-invalid";

  if (error.status === 0 || error.status >= 502) return "unavailable";
  if (error.status === 401) return "unauthenticated";
  if (error.status === 403) return "permission-denied";
  if (error.status === 404) return "not-found";
  if (error.status === 409) return ALREADY_EXISTS_CODES.has(error.code) ? "already-exists" : "failed-precondition";
  if (error.status === 400) return "invalid-argument";
  return "internal";
}
