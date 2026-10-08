import { HttpError } from "../utils/httpError.js";
import { todayInTimeZone } from "../utils/companyDate.js";
import { LEAVE_TYPES } from "../utils/leaveTypes.js";
import { USER_ROLES } from "../utils/roles.js";
import { scopeCoversEmployee } from "./employeeScopeService.js";

/**
 * Leave USED by an employee in a calendar year: days taken, not days remaining (D40). There are no
 * entitlements, so there is no total and no remaining figure to report.
 *
 * Who may read one (D31, unchanged by D40): the employee themselves, plus approvers within the scope
 * they can already read leaves for -- admin and hr any employee, a manager their department, a tl their
 * team. That is exactly employeeScopeService's scope, so it is reused rather than restated. An approver
 * needs the number to decide.
 *
 * What counts: APPROVED leave only, per leave type, each leave attributed whole to the calendar year it
 * starts in -- which is what the employee_leave_usage view holds since migration 011. A pending request
 * is not counted until it is approved.
 *
 * @param {object} dependencies
 * @param {string} dependencies.timeZone - IANA zone that defines "today" (COMPANY_TIMEZONE).
 * @param {() => Date} [dependencies.now] - the clock; injectable so tests do not depend on wall time.
 */
export function createLeaveBalanceService({ leaveRepository, employeeRepository, timeZone, now = () => new Date() }) {
  return Object.freeze({
    /**
     * `employeeId` defaults to the principal; `asOf` (`YYYY-MM-DD`) defaults to today in the company
     * timezone, and only its calendar year matters. An employee who does not exist and one outside the
     * caller's scope get the same 404, matching the read convention, so an id's existence is never
     * confirmed. Every leave type is always present in `taken`, with 0 where nothing was taken.
     */
    async getBalance(principal, { employeeId, asOf } = {}) {
      if (!USER_ROLES.includes(principal?.role) || !principal.employeeId) {
        throw new HttpError(403, "role_not_allowed", "This account cannot read leave balances.");
      }

      const targetId = employeeId ?? principal.employeeId;
      const employee = await employeeRepository.findById(targetId);
      if (!employee || !scopeCoversEmployee(principal, employee)) {
        throw new HttpError(404, "not_found", "The requested employee was not found.");
      }

      const date = asOf ?? todayInTimeZone(now(), timeZone);
      const year = Number(date.slice(0, 4));
      const rows = await leaveRepository.daysTaken(targetId, year);
      if (!rows) throw new HttpError(404, "not_found", "The requested employee was not found.");

      const taken = Object.fromEntries(LEAVE_TYPES.map((type) => [type, 0]));
      for (const { type, days_used: daysUsed } of rows) {
        if (Object.hasOwn(taken, type)) taken[type] += Number(daysUsed);
      }
      const total = Object.values(taken).reduce((sum, days) => sum + days, 0);

      return { employee_id: targetId, as_of: date, year, taken, total };
    },
  });
}
