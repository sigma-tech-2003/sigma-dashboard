import { HttpError } from "../utils/httpError.js";
import { PAYROLL_ROLES } from "./employeeAuthorizationService.js";

/**
 * Who may create, edit and delete payroll (D28): admin and hr, for any employee. Matches
 * firestore.rules, the auth matrix, Phase 7 and the frontend's managePayroll. Reuses
 * PAYROLL_ROLES -- the same admin/hr set that already gates changing an employee's basic and
 * allowances -- rather than restating it.
 *
 * There is deliberately no per-employee scope function alongside this one, unlike attendance:
 * payroll writers are company-wide, so the role gate is the whole authorization decision.
 * manager, tl and employee are denied; an employee's read access to their own processed rows is
 * a read-side rule (buildPayrollScopeFilter) and unaffected.
 */
export function assertCanWritePayroll(principal) {
  if (!PAYROLL_ROLES.has(principal?.role)) {
    throw new HttpError(403, "role_not_allowed", "This account cannot manage payroll records.");
  }
  // The acting employee's id becomes deleted_by_employee_id on a delete (D28), so an account not
  // linked to an employee record cannot write -- not even an admin. Same demand as attendance.
  if (!principal.employeeId) {
    throw new HttpError(403, "role_not_allowed", "This account is not linked to an employee record.");
  }
}
