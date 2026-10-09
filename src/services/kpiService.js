import * as mapper from "./mappers/kpi.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

export function createKpiService(api = defaultApi) {
  const base = createResourceService({ path: "/kpis", mapper, api });

  return {
    ...base,

    /**
     * The KPI page saves a rating through the same call as a progress update
     * (`{ rating, ratedBy, ratedAt }`). The API has two operations: PATCH for progress and
     * POST /kpis/:id/rating for the rating, which also records WHO rated and WHEN on the server, so `ratedBy` and
     * `ratedAt` from the page are ignored. Both are made if both are present.
     */
    async update(id, changes, context) {
      const { rating } = changes;
      const progress = { ...changes };
      for (const key of ["rating", "ratedBy", "ratedAt"]) delete progress[key];

      let result = Object.keys(mapper.toApiUpdate(progress, context)).length > 0
        ? await base.update(id, progress, context)
        : (context?.original ?? null);

      if (rating !== undefined && rating !== null) {
        result = base.read(await api.post(`/kpis/${id}/rating`, mapper.toApiRating(rating)));
      }
      return result;
    },
  };
}

export const kpiService = createKpiService();
