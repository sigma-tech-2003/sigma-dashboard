import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { payrollCreateSchema, payrollUpdateSchema } from "../validation/payrollSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested payroll record was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring attendanceController.js exactly: parses/validates the request
 * shape, then hands off entirely to payrollMutationService -- no authorization or business logic
 * lives here. A malformed :id is a 404, not a 400, matching the read side.
 *
 * @param {() => object} getPayrollMutationService - called per-request, not at construction
 *   time, matching every other getX() getter in this codebase.
 */
export function createPayrollController(getPayrollMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = payrollCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The payroll payload is invalid.");

        const record = await getPayrollMutationService().createPayroll(req.principal, parsed.data);
        res.status(201).json({ data: record });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = payrollUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The payroll payload is invalid.");

        const record = await getPayrollMutationService().updatePayroll(req.principal, id, parsed.data);
        res.status(200).json({ data: record });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getPayrollMutationService().deletePayroll(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
