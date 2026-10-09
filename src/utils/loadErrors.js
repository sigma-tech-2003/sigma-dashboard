// What a page should do when a collection FAILED to load, kept free of React so it can be tested under
// `node --test`. The rule it encodes: a failed request must never look like an empty result.
//
//   blocked  a required collection failed AND has nothing to show. Rendering the page would show zeros and
//            "no records" for data that is merely missing, so the page body is replaced by an error.
//   stale    something failed but there is data from an earlier load (or the collection is optional): show the
//            data with a warning that it may be out of date.
//   ok       nothing failed.
//
// `errors` is a map of collection name -> the hook's LOAD error (not a write error; those are the pages' own).
// `required` and `optional` map collection name -> the array the page is about to render.

export const COLLECTION_LABELS = Object.freeze({
  employees: "employees",
  projects: "projects",
  kpis: "KPIs",
  attendance: "attendance records",
  leaves: "leave requests",
  payroll: "payroll records",
  leaveBalances: "leave usage",
  departments: "departments",
});

const GENERIC_MESSAGE = "The data could not be loaded.";

/**
 * A sentence that is safe to show. Only an ApiError's message is used (the server sends curated text, and the client
 * writes its own for network and gateway failures); anything else, such as a stray TypeError, gets a generic line so
 * no internal detail reaches the screen.
 */
export function describeLoadError(error) {
  if (error?.name === "ApiError" && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return GENERIC_MESSAGE;
}

const isEmpty = (rows) => !Array.isArray(rows) || rows.length === 0;

// `hasData`: there is something from an earlier load on screen (so it is out of date), as opposed to nothing at all
// (so related figures are missing). The two need different words.
const entry = (name, error, rows) => ({
  name,
  label: COLLECTION_LABELS[name] ?? name,
  message: describeLoadError(error),
  hasData: !isEmpty(rows),
});

/** "a", "a and b", "a, b and c" */
export function joinLabels(labels) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * @param {{ errors?: Record<string, unknown>, required?: Record<string, unknown[]>, optional?: Record<string, unknown[]> }} input
 * @returns {{ status: "ok" | "stale" | "blocked", blocking: Array<{name: string, label: string, message: string, hasData: boolean}>, stale: Array<{name: string, label: string, message: string, hasData: boolean}>, messages: string[] }}
 */
export function evaluateLoadErrors({ errors = {}, required = {}, optional = {} } = {}) {
  const blocking = [];
  const stale = [];

  for (const [name, rows] of Object.entries(required)) {
    const error = errors?.[name];
    if (!error) continue;
    (isEmpty(rows) ? blocking : stale).push(entry(name, error, rows));
  }
  // An optional collection never blocks the page: the page has a fallback, or can do without it.
  for (const [name, rows] of Object.entries(optional)) {
    const error = errors?.[name];
    if (error) stale.push(entry(name, error, rows));
  }

  const status = blocking.length > 0 ? "blocked" : stale.length > 0 ? "stale" : "ok";
  const messages = [...new Set([...blocking, ...stale].map((item) => item.message))];
  return { status, blocking, stale, messages };
}
