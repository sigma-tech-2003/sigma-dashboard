import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { projectCreateSchema, projectUpdateSchema } from "../validation/projectSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested project was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring attendanceController.js and payrollController.js exactly: parses and
 * validates the request shape, then hands off entirely to projectMutationService -- no
 * authorization or business logic lives here. A malformed :id is a 404, not a 400, matching the
 * read side.
 *
 * @param {() => object} getProjectMutationService - called per-request, not at construction time,
 *   matching every other getX() getter in this codebase.
 */
export function createProjectController(getProjectMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = projectCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The project payload is invalid.");

        const project = await getProjectMutationService().createProject(req.principal, parsed.data);
        res.status(201).json({ data: project });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = projectUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The project payload is invalid.");

        const project = await getProjectMutationService().updateProject(req.principal, id, parsed.data);
        res.status(200).json({ data: project });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getProjectMutationService().deleteProject(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
