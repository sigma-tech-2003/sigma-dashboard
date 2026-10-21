import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { employeeCreateSchema, employeeDeleteSchema, employeeUpdateSchema } from "../validation/employeeSchemas.js";
import { resetPasswordSchema } from "../validation/passwordSchemas.js";

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

    /**
     * Admin/hr only, and only for roles the caller may manage -- enforced in the service (assertCanResetPassword),
     * not here. Sets a new TEMPORARY password for an existing employee (D41): they must change it at their next
     * sign-in, and every session they have open is ended. 204: the password is never echoed.
     */
    async resetPassword(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = resetPasswordSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("A temporary password of 8 to 200 characters is required.");

        await getEmployeeMutationService().resetPassword(req.principal, id, parsed.data.temporary_password);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
