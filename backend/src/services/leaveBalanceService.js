import { HttpError } from "../utils/httpError.js";
import { todayInTimeZone } from "../utils/companyDate.js";
import { USER_ROLES } from "../utils/roles.js";
import { computeBalance } from "./leaveEntitlements.js";
import { scopeCoversEmployee } from "./employeeScopeService.js";

/**
 * A leave balance, derived from `leaves` at read time and never stored (D4, D31).
 *
 * Who may read one (D31): the employee themselves, plus approvers within the scope they can already
 * read leaves for -- admin and hr any employee, a manager their department, a tl their team. That is
 * exactly employeeScopeService's scope, so it is reused rather than restated. It is a widening of
 * Firestore, which let only the employee read their own balance and denied admin and hr, but an
 * approver needs the number to decide.
 *
 * @param {object} dependencies
 * @param {string} dependencies.timeZone - IANA zone that defines "today" (COMPANY_TIMEZONE).
 * @param {() => Date} [dependencies.now] - the clock; injectable so tests do not depend on wall time.
 */
export function createLeaveBalanceService({ leaveRepository, employeeRepository, timeZone, now = () => new Date() }) {
  return Object.freeze({
    /**
     * `employeeId` defaults to the principal; `asOf` (`YYYY-MM-DD`) defaults to today in the company
     * timezone. The balance is for that date's calendar month (the monthly pool) and calendar year
     * (the serious-need pool). An employee who does not exist and one outside the caller's scope get
     * the same 404, matching the read convention, so an id's existence is never confirmed.
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
      const inputs = await leaveRepository.balanceInputs(targetId, [Number(date.slice(0, 4))]);
      if (!inputs) throw new HttpError(404, "not_found", "The requested employee was not found.");

      return { employee_id: targetId, ...computeBalance({ joinedOn: inputs.joinedOn, usage: inputs.usage, asOf: date }) };
    },
  });
}
