import { kpiService } from "./kpiService.js";
import { legacyCodeFor } from "./mutationErrors.js";

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to manage this KPI.",
  "invalid-argument": "Review the KPI details and try again.",
  "not-found": "This KPI or a related record could not be found.",
  "already-exists": "This KPI conflicts with an existing record.",
  "failed-precondition": "The KPI could not be verified in its current state.",
  aborted: "The KPI changed during this operation. Please try again.",
  unavailable: "KPI management is temporarily unavailable. Please try again.",
  "malformed-response": "The KPI response could not be verified.",
  internal: "KPI management could not be completed.",
});

export class KpiMutationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "KpiMutationError";
    this.code = safeCode;
  }
}

const failure = (error) => (error instanceof KpiMutationError ? error : new KpiMutationError(legacyCodeFor(error)));

const requiredId = (value) => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new KpiMutationError("invalid-argument");
  return id;
};

/** POST /kpis. Resolves the created KPI, whose `id` is the server's. */
export async function createKpi(kpi) {
  try {
    return await kpiService.create(kpi);
  } catch (error) {
    throw failure(error);
  }
}

/**
 * Progress changes go to PATCH /kpis/:id; a `rating` goes to POST /kpis/:id/rating, which records the rater
 * and the time on the server.
 */
export async function updateKpi(kpiId, updates, { original } = {}) {
  try {
    return await kpiService.update(requiredId(kpiId), updates, { original });
  } catch (error) {
    throw failure(error);
  }
}

export async function deleteKpi(kpiId) {
  try {
    const id = requiredId(kpiId);
    await kpiService.remove(id);
    return { id, deleted: true };
  } catch (error) {
    throw failure(error);
  }
}
