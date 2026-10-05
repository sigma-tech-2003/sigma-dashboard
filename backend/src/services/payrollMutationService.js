import { HttpError } from "../utils/httpError.js";
import { assertCanWritePayroll } from "./payrollAuthorizationService.js";

/**
 * Orchestrates payroll create/update/delete (D7, D28). Who may write lives in
 * payrollAuthorizationService.js; the arithmetic lives in the database (gross, tax and net are
 * generated columns), so this service does none. What it owns is what a column cannot express:
 * defaulting basic and allowances from the employee, that the employee exists, and that a
 * processed record is immutable.
 *
 * Deliberately absent, per D28: any period/temporal check (future periods are allowed, as in
 * Firestore) and any employment_status check (a terminated or inactive employee can still be paid
 * their final month, unlike attendance's active requirement).
 */
export function createPayrollMutationService({ payrollRepository, employeeRepository }) {
  /** D28: the referenced employee must be live; their employment_status is not consulted. */
  async function loadEmployeeOrReject(employeeId) {
    const employee = await employeeRepository.findById(employeeId);
    if (!employee) {
      throw new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    return employee;
  }

  return Object.freeze({
    /**
     * basic and allowances default to the employee's CURRENT values when omitted; explicit
     * values win (backdated periods, raises, corrections). bonus and deductions have already
     * defaulted to 0 and status to 'processed' in the schema. The employee row's numerics arrive
     * from pg as strings, which a numeric parameter accepts as-is.
     */
    async createPayroll(principal, input) {
      assertCanWritePayroll(principal);

      const employee = await loadEmployeeOrReject(input.employee_id);

      return payrollRepository.create({
        ...input,
        basic: input.basic ?? employee.basic,
        allowances: input.allowances ?? employee.allowances,
      });
    },

    /**
     * D28: a draft is fully editable and may be promoted to processed, alone or together with
     * field edits; a processed record is immutable, so ANY edit of one -- including an attempt
     * to put it back to draft -- is refused. payrollRepository.updateById enforces the same rule
     * atomically in SQL, so a record promoted between this read and the write is still refused.
     * basic and allowances are not re-defaulted when employee_id changes: defaulting is
     * create-only, and an explicit change is the caller's to make.
     */
    async updatePayroll(principal, payrollId, changes) {
      assertCanWritePayroll(principal);

      const existing = await payrollRepository.findById(payrollId);
      if (!existing) throw new HttpError(404, "not_found", "Payroll record not found.");

      if (existing.status === "processed") {
        throw new HttpError(
          409,
          "payroll_not_editable",
          "A processed payroll record cannot be changed; delete it and process a new one.",
        );
      }

      if (Object.hasOwn(changes, "employee_id") && changes.employee_id !== existing.employee_id) {
        await loadEmployeeOrReject(changes.employee_id);
      }

      const updated = await payrollRepository.updateById(payrollId, changes);
      if (!updated) throw new HttpError(404, "not_found", "Payroll record not found.");
      return updated;
    },

    /** Soft delete, any status; the actor is recorded in deleted_by_employee_id. */
    async deletePayroll(principal, payrollId) {
      assertCanWritePayroll(principal);

      const existing = await payrollRepository.findById(payrollId);
      if (!existing) throw new HttpError(404, "not_found", "Payroll record not found.");

      await payrollRepository.deleteById(payrollId, principal.employeeId);
    },
  });
}
