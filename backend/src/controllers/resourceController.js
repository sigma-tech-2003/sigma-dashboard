import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";

/**
 * Shared by every read-only Phase 3 domain (employees, departments, projects, kpis,
 * leaves, attendance, payroll): list and getById are identical in shape across all seven
 * -- fetch via the repository's *ForPrincipal method, wrap in JSON, 404 on a miss. The
 * only thing that differs per domain is which repository is called and the resource name
 * in the 404 message, so one factory replaces seven near-identical files.
 *
 * A malformed id is treated the same as a valid-but-out-of-scope id: 404, not 400. Neither
 * confirms to the caller whether the id was well-formed, which resource ids exist, or
 * which the caller merely cannot see -- matching the scope-filtered query's own behavior,
 * where an out-of-scope id already returns no row indistinguishably from a nonexistent one.
 *
 * @param {() => object} getRepository - called per-request, not at construction time, so
 *   building the router never opens a pool or demands config -- mirrors how
 *   container.js's verifyAccessToken defers getContainer() until a request actually needs
 *   it, not at import time.
 */
export function createResourceController(getRepository, { resourceName }) {
  const notFound = () => new HttpError(404, "not_found", `The requested ${resourceName} was not found.`);

  return Object.freeze({
    async list(req, res, next) {
      try {
        const items = await getRepository().listForPrincipal(req.principal);
        res.status(200).json({ data: items });
      } catch (error) {
        next(error);
      }
    },

    async getById(req, res, next) {
      try {
        const { success, data: id } = uuidSchema.safeParse(req.params.id);
        if (!success) throw notFound();

        const item = await getRepository().findByIdForPrincipal(id, req.principal);
        if (!item) throw notFound();

        res.status(200).json({ data: item });
      } catch (error) {
        next(error);
      }
    },
  });
}
