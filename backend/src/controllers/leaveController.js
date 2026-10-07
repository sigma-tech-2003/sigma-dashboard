import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { leaveApplySchema, leaveDecisionSchema } from "../validation/leaveSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested leave request was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring the other write controllers exactly: parses and validates the request
 * shape, then hands off entirely to leaveMutationService -- no authorization or business logic lives
 * here. A malformed :id is a 404, not a 400, matching the read side.
 *
 * Three operations, no more (D31): POST applies, PATCH approves or rejects (the body is `{ status }`
 * and nothing else -- there is no edit), DELETE cancels or deletes. Approve is a PATCH because that is
 * exactly what the frontend's updateLeaveStatus(id, status) already is, and cancel is a DELETE
 * authorized differently by role and status.
 *
 * @param {() => object} getLeaveMutationService - called per-request, not at construction time.
 */
export function createLeaveController(getLeaveMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = leaveApplySchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The leave request payload is invalid.");

        const leave = await getLeaveMutationService().applyLeave(req.principal, parsed.data);
        res.status(201).json({ data: leave });
      } catch (error) {
        next(error);
      }
    },

    async decide(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = leaveDecisionSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The decision payload is invalid.");

        const leave = await getLeaveMutationService().decideLeave(req.principal, id, parsed.data);
        res.status(200).json({ data: leave });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getLeaveMutationService().deleteLeave(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
