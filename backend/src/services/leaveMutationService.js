import { HttpError } from "../utils/httpError.js";
import { todayInTimeZone } from "../utils/companyDate.js";
import {
  assertCanApply,
  assertCanDecide,
  assertCanDecideRole,
  resolveDeleteMode,
} from "./leaveAuthorizationService.js";
import { findOverage } from "./leaveEntitlements.js";

/**
 * Orchestrates leave apply / decide / delete (D31). Who may do what is
 * leaveAuthorizationService.js; how much leave an employee has, and which leave type draws on which
 * pool, is leaveEntitlements.js. What this owns is the order of operations and the two refusals the
 * database cannot express: a request that overlaps the employee's own pending or approved leave, and
 * one that would exceed a pool.
 *
 * Deliberately NOT here: the self-approval ban. leaves_no_self_approval is a database constraint
 * (D8) and leaveRepository turns its violation into a clean 403; and no balance re-check at approval,
 * because a pending request already counts against the balance, so approving it changes nothing and
 * rejecting it only frees days.
 *
 * @param {object} dependencies
 * @param {string} dependencies.timeZone - IANA zone that defines "today" (COMPANY_TIMEZONE).
 * @param {() => Date} [dependencies.now] - the clock; injectable so tests do not depend on wall time.
 */
export function createLeaveMutationService({ leaveRepository, timeZone, now = () => new Date() }) {
  return Object.freeze({
    /**
     * Applies for leave -- for the acting principal only, whatever role they hold. `applied_on` is the
     * server's: today in the company timezone, never client-supplied. The checks run inside the
     * repository's transaction, under a lock on the applicant's employee row, so two concurrent
     * requests cannot both pass against the same usage.
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
        async ({ joinedOn, overlapping, usage }) => {
          if (overlapping.length > 0) {
            throw new HttpError(
              409,
              "leave_overlaps",
              "This request overlaps another pending or approved leave of yours.",
              { existing_id: overlapping[0].id },
            );
          }

          const overage = findOverage({
            type: input.type, startDate: input.start_date, endDate: input.end_date, joinedOn, usage,
          });
          if (overage) {
            throw new HttpError(
              409,
              "leave_balance_exceeded",
              `This request would exceed your ${overage.pool === "monthly" ? "monthly" : "yearly serious-need"} allowance.`,
              overage,
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
