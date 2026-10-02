import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { attendanceCreateSchema, attendanceUpdateSchema } from "../validation/attendanceSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested attendance record was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring departmentController.js exactly: parses/validates the request
 * shape, then hands off entirely to attendanceMutationService -- no authorization or business
 * logic lives here. A malformed :id is a 404, not a 400, matching the read side.
 *
 * @param {() => object} getAttendanceMutationService - called per-request, not at
 *   construction time, matching every other getX() getter in this codebase.
 */
export function createAttendanceController(getAttendanceMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = attendanceCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The attendance payload is invalid.");

        const record = await getAttendanceMutationService().createAttendance(req.principal, parsed.data);
        res.status(201).json({ data: record });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = attendanceUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The attendance payload is invalid.");

        const record = await getAttendanceMutationService().updateAttendance(req.principal, id, parsed.data);
        res.status(200).json({ data: record });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getAttendanceMutationService().deleteAttendance(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
