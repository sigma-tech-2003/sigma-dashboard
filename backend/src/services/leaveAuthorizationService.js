import { HttpError } from "../utils/httpError.js";
import { USER_ROLES } from "../utils/roles.js";

const denied = (code, message) => new HttpError(403, code, message);

/**
 * Who may apply (D12, settled by D31): every role, for themselves only. The applicant is always the
 * acting principal -- there is no way to apply for someone else -- so the only gate is that the
 * account is a known role linked to an employee record (the leave's employee_id is that record).
 */
export function assertCanApply(principal) {
  if (!USER_ROLES.includes(principal?.role)) {
    throw denied("role_not_allowed", "This account cannot apply for leave.");
  }
  if (!principal.employeeId) {
    throw denied("role_not_allowed", "This account is not linked to an employee record.");
  }
}

/**
 * The role gate for deciding, on its own so the service can run it BEFORE looking the leave up: a
 * role that may never decide must get the same answer whether or not the id exists.
 */
export function assertCanDecideRole(principal) {
  if (!["admin", "hr", "manager", "tl"].includes(principal?.role) || !principal.employeeId) {
    throw denied("role_not_allowed", "This account cannot approve or reject leave requests.");
  }
}

/**
 * Who may approve or reject (D31, the Firestore scopes carried over): admin and hr any request; a
 * manager their own department's; a tl the requests of employees who report to them; an employee
 * none. `leave` is the row from leaveRepository.findByIdForWrite.
 *
 * Deliberately NOT checked here: that nobody decides their own request. leaves_no_self_approval
 * refuses that in the database for every role (D8), and leaveRepository turns it into a clean 403;
 * duplicating it here would stop the database from being the thing that provably refuses it. (A tl
 * cannot even reach it: an employee cannot be their own team lead, so a tl's own request is never in
 * their team.)
 */
export function assertCanDecide(principal, leave) {
  assertCanDecideRole(principal);
  const role = principal.role;
  if (role === "admin" || role === "hr") return;

  const inScope = role === "manager"
    ? Boolean(principal.departmentId) && leave.employee_department_id === principal.departmentId
    : leave.employee_team_lead_id === principal.employeeId;
  if (!inScope) throw denied("leave_scope_denied", "This leave request is outside your scope.");
}

/**
 * Who may delete, and how (D31): admin and hr may delete a leave in ANY status, as the correction path
 * for a mistaken approval; an employee -- any role -- may cancel their OWN request while it is still
 * pending, and cannot cancel one that has been decided; nobody else may delete anything.
 *
 * Returns `{ pendingOnly }`, which the repository turns into a status guard on the UPDATE itself, so a
 * request decided between this read and the write is refused rather than cancelled.
 */
export function resolveDeleteMode(principal, leave) {
  if (!USER_ROLES.includes(principal?.role) || !principal.employeeId) {
    throw denied("role_not_allowed", "This account cannot delete leave requests.");
  }
  if (principal.role === "admin" || principal.role === "hr") return { pendingOnly: false };

  if (leave.employee_id !== principal.employeeId) {
    throw denied("leave_scope_denied", "You can only cancel your own leave requests.");
  }
  if (leave.status !== "pending") {
    throw new HttpError(409, "leave_already_decided", "A decided leave request cannot be cancelled.");
  }
  return { pendingOnly: true };
}
