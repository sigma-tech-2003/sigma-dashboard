import { HttpError } from "../utils/httpError.js";
import { todayInTimeZone } from "../utils/companyDate.js";
import {
  assertCanApply,
  assertCanDecide,
  assertCanDecideRole,
  resolveDeleteMode,
} from "./leaveAuthorizationService.js";

/**
 * Orchestrates leave apply / decide / delete (D31, D40). Who may do what is
 * leaveAuthorizationService.js. What this owns is the order of operations and the one refusal the
 * database cannot express: a request that overlaps the employee's own pending or approved leave.
 *
 * There is no entitlement and no limit (D40): approval is the only control, so nothing here refuses a
 * request for being too long or too many.
 *
 * Deliberately NOT here: the self-approval ban. leaves_no_self_approval is a database constraint
 * (D8) and leaveRepository turns its violation into a clean 403.
 *
 * @param {object} dependencies
 * @param {string} dependencies.timeZone - IANA zone that defines "today" (COMPANY_TIMEZONE).
 * @param {() => Date} [dependencies.now] - the clock; injectable so tests do not depend on wall time.
 */
export function createLeaveMutationService({ leaveRepository, timeZone, now = () => new Date() }) {
  return Object.freeze({
    /**
     * Applies for leave -- for the acting principal only, whatever role they hold. `applied_on` is the
     * server's: today in the company timezone, never client-supplied. The overlap check runs inside the
     * repository's transaction, under a lock on the applicant's employee row, so two concurrent
     * requests for the same dates cannot both pass it.
     */
    async applyLeave(principal, input) {
      assertCanApply(principal);

      return leaveRepository.create(
        {
          employee_id: principal.employeeId,
          type: input.type,
          start_date: input.start_date,
          end_date: input.end_date,
          reason: input.reason,
          applied_on: todayInTimeZone(now(), timeZone),
        },
        async ({ overlapping }) => {
          if (overlapping.length > 0) {
            throw new HttpError(
              409,
              "leave_overlaps",
              "This request overlaps another pending or approved leave of yours.",
              { existing_id: overlapping[0].id },
            );
          }
        },
      );
    },

    /** Approve or reject. Scope first, then a guarded write; a decided leave is immutable. */
    async decideLeave(principal, leaveId, { status }) {
      // The role gate runs before the 404, so a role that may never decide learns nothing about ids.
      assertCanDecideRole(principal);
      const existing = await leaveRepository.findByIdForWrite(leaveId);
      if (!existing) throw new HttpError(404, "not_found", "Leave request not found.");
      assertCanDecide(principal, existing);

      const decided = await leaveRepository.decide(leaveId, { status, decidedByEmployeeId: principal.employeeId });
      if (!decided) throw new HttpError(404, "not_found", "Leave request not found.");
      return decided;
    },

    /** Cancel (an employee's own pending request) or delete (admin/hr, any status): a soft delete. */
    async deleteLeave(principal, leaveId) {
      const existing = await leaveRepository.findByIdForWrite(leaveId);
      if (!existing) throw new HttpError(404, "not_found", "Leave request not found.");

      const mode = resolveDeleteMode(principal, existing);
      await leaveRepository.deleteById(leaveId, principal.employeeId, mode);
    },
  });
}
