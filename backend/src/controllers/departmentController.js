import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { departmentCreateSchema, departmentUpdateSchema } from "../validation/departmentSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested department was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring employeeController.js exactly: parses/validates the request
 * shape, then hands off entirely to departmentMutationService -- no authorization or
 * business logic lives here. A malformed :id is treated the same as the read side: 404, not
 * 400, so a write attempt against a nonexistent department never confirms whether the id
 * was merely malformed.
 *
 * @param {() => object} getDepartmentMutationService - called per-request, not at
 *   construction time, matching every other getX() getter in this codebase.
 */
export function createDepartmentController(getDepartmentMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = departmentCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The department payload is invalid.");

        const department = await getDepartmentMutationService().createDepartment(req.principal, parsed.data);
        res.status(201).json({ data: department });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = departmentUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The department payload is invalid.");

        const department = await getDepartmentMutationService().updateDepartment(req.principal, id, parsed.data);
        res.status(200).json({ data: department });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getDepartmentMutationService().deleteDepartment(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
