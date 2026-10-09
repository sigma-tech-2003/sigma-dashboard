import { MappingError } from "./common.js";

// Leave usage (D40). There are no entitlements, so there is no total or remaining figure: only days TAKEN.
//
// GET /leave-balances answers for ONE employee. The pages index balances by employee id
// (`leaveBalances[user.id]`), so the mapper returns a one-entry map keyed by that employee's id, and a caller
// holding several responses merges them with `Object.assign`.
//
// This deliberately does NOT produce the old `{ t, u, r }` per-type cards: there is no `t` (total allowed) or
// `r` (remaining) to put in them, and inventing one would show a limit that does not exist. The cards that read
// `.t` / `.r` change in Phase 10's UI work.

export function fromApi(response) {
  if (!response || typeof response.employee_id !== "string" || response.taken == null || typeof response.taken !== "object") {
    throw new MappingError("malformed-response", "The leave balance response could not be read.");
  }
  return {
    [response.employee_id]: {
      taken: { ...response.taken },
      total: response.total,
      year: response.year,
      asOf: response.as_of,
    },
  };
}

/** GET /leave-balances query string: the employee (omitted for the caller's own) and an optional date. */
export function toApiQuery({ employeeId, asOf } = {}) {
  return {
    employee_id: employeeId == null || employeeId === "" ? undefined : String(employeeId),
    as_of: asOf || undefined,
  };
}
