import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { employeeCreateSchema, employeeDeleteSchema, employeeUpdateSchema } from "../validation/employeeSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested employee was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer: parses/validates the request shape, then hands off entirely to
 * employeeMutationService -- no authorization or business logic lives here. A malformed
 * :id is treated the same as resourceController.js treats one on the read side: 404, not
 * 400, so a write attempt against a nonexistent employee never confirms whether the id was
 * merely malformed.
 *
 * @param {() => object} getEmployeeMutationService - called per-request, not at
 *   construction time, matching every other getX() getter in this codebase.
 */
export function createEmployeeController(getEmployeeMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = employeeCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The employee payload is invalid.");

        const employee = await getEmployeeMutationService().createEmployee(req.principal, parsed.data);
        res.status(201).json({ data: employee });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = employeeUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The employee payload is invalid.");

        const employee = await getEmployeeMutationService().updateEmployee(req.principal, id, parsed.data);
        res.status(200).json({ data: employee });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = employeeDeleteSchema.safeParse(req.body ?? {});
        if (!parsed.success) throw invalidRequest("The delete payload is invalid.");

        await getEmployeeMutationService().deleteEmployee(req.principal, id, {
          replacementTeamLeadId: parsed.data.replacement_team_lead_id ?? null,
        });
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
