import { HttpError } from "../utils/httpError.js";
import { scopeCoversEmployee } from "./employeeScopeService.js";

/**
 * Who may create, edit and delete attendance (D27). Matches firestore.rules'
 * canManageCanonicalEmployeeRecord and the auth matrix: admin and hr for anyone, manager for
 * their own department, and nobody else -- tl and employee never could write attendance in
 * Firestore, and still cannot.
 */
export const ATTENDANCE_WRITE_ROLES = new Set(["admin", "hr", "manager"]);

const denied = (code, message) => new HttpError(403, code, message);

/**
 * The role gate, ahead of any database access. An account with no employee record is also
 * refused: the acting employee's id is recorded as deleted_by_employee_id on a delete (D27),
 * and employeeAuthorizationService.js's assertActingRoleKnown makes the same demand.
 */
export function assertCanWriteAttendance(principal) {
  if (!ATTENDANCE_WRITE_ROLES.has(principal?.role)) {
    throw denied("role_not_allowed", "This account cannot manage attendance records.");
  }
  if (!principal.employeeId) {
    throw denied("role_not_allowed", "This account is not linked to an employee record.");
  }
}

/**
 * The role gate plus scope over one employee. `employee` needs `id` and `department_id`.
 * Scope reuses scopeCoversEmployee so it can never drift from the read-side scope: admin and hr
 * cover everyone, a manager covers their own department (a manager with no department covers
 * nobody).
 */
export function assertCanWriteAttendanceFor(principal, employee, message = "This employee is outside your scope.") {
  assertCanWriteAttendance(principal);
  if (!scopeCoversEmployee(principal, employee)) {
    throw denied("attendance_scope_denied", message);
  }
}

/**
 * Moving a record between employees (D27): the scope check covers the employee the record is
 * moving FROM and the one it is moving TO, FROM first. Checking only the destination would let
 * a manager pull a record out of another department into their own and end up holding a record
 * they were never allowed to touch.
 */
export function assertCanReattributeAttendance(principal, { from, to }) {
  assertCanWriteAttendanceFor(principal, from, "This record belongs to an employee outside your scope.");
  assertCanWriteAttendanceFor(principal, to, "The employee you are moving this record to is outside your scope.");
}
