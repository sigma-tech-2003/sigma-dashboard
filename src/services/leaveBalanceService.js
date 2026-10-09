import * as mapper from "./mappers/leaveBalance.js";
import { api as defaultApi } from "./apiClient.js";

// Leave USAGE (D40), not balances: days taken per type in a year. GET /leave-balances answers for one employee
// per call, and the query goes through the mapper like every other request.
export function createLeaveBalanceService(api = defaultApi) {
  return {
    /**
     * The usage for one employee as the one-record array the generic collection hook expects:
     * [{ _docId: employeeId, taken, total, year, asOf }]. The hook folds it into { [employeeId]: {...} }.
     */
    async forEmployee(employeeId, { asOf } = {}) {
      const response = await api.get("/leave-balances", { query: mapper.toApiQuery({ employeeId, asOf }) });
      return Object.entries(mapper.fromApi(response)).map(([id, usage]) => ({ _docId: id, ...usage }));
    },
  };
}

export const leaveBalanceService = createLeaveBalanceService();
