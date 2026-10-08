import { HttpError } from "../utils/httpError.js";
import { leaveBalanceQuerySchema } from "../validation/leaveSchemas.js";

/**
 * Thin HTTP layer for the days-taken read (D40): validates the query string, then hands off to
 * leaveBalanceService, which owns who may read whose balance.
 *
 * @param {() => object} getLeaveBalanceService - called per-request, not at construction time.
 */
export function createLeaveBalanceController(getLeaveBalanceService) {
  return Object.freeze({
    async get(req, res, next) {
      try {
        const parsed = leaveBalanceQuerySchema.safeParse(req.query);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "The balance query is invalid.");

        const balance = await getLeaveBalanceService().getBalance(req.principal, {
          employeeId: parsed.data.employee_id,
          asOf: parsed.data.as_of,
        });
        res.status(200).json({ data: balance });
      } catch (error) {
        next(error);
      }
    },
  });
}
