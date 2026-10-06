import { HttpError } from "../utils/httpError.js";
import { uuidSchema } from "../validation/commonSchemas.js";
import { kpiCreateSchema, kpiRatingSchema, kpiUpdateSchema } from "../validation/kpiSchemas.js";

const notFound = () => new HttpError(404, "not_found", "The requested KPI was not found.");
const invalidRequest = (message) => new HttpError(400, "invalid_request", message);

/**
 * Thin HTTP layer, mirroring the other write controllers exactly: parses and validates the request
 * shape, then hands off entirely to kpiMutationService. A malformed :id is a 404, not a 400.
 *
 * @param {() => object} getKpiMutationService - called per-request, not at construction time.
 */
export function createKpiController(getKpiMutationService) {
  return Object.freeze({
    async create(req, res, next) {
      try {
        const parsed = kpiCreateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The KPI payload is invalid.");

        const kpi = await getKpiMutationService().createKpi(req.principal, parsed.data);
        res.status(201).json({ data: kpi });
      } catch (error) {
        next(error);
      }
    },

    async update(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = kpiUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The KPI payload is invalid.");

        const kpi = await getKpiMutationService().updateKpi(req.principal, id, parsed.data);
        res.status(200).json({ data: kpi });
      } catch (error) {
        next(error);
      }
    },

    /** The rating's own operation (D29): the body is `{ rating }` and nothing else. */
    async rate(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        const parsed = kpiRatingSchema.safeParse(req.body);
        if (!parsed.success) throw invalidRequest("The rating payload is invalid.");

        const kpi = await getKpiMutationService().rateKpi(req.principal, id, parsed.data);
        res.status(200).json({ data: kpi });
      } catch (error) {
        next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const { success: idOk, data: id } = uuidSchema.safeParse(req.params.id);
        if (!idOk) throw notFound();

        await getKpiMutationService().deleteKpi(req.principal, id);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  });
}
