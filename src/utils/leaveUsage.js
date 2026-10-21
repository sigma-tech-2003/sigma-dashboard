// Leave USAGE for the cards on the Leave page and the dashboard (D40). There are no entitlements, so there is no
// total allowed and no remaining figure, only days taken. `balance` is the one-employee entry from
// services/mappers/leaveBalance.js: { taken: { Annual: 3, Sick: 0, ... }, total, year, asOf }, or undefined while
// nothing has loaded.

/** One card per leave type the API reported: [{ type, days, year }]. Nothing before the usage has loaded. */
export function usageCards(balance) {
  return Object.entries(balance?.taken ?? {}).map(([type, days]) => ({ type, days, year: balance.year }));
}

/** Total days taken in the year, as the dashboard shows it. "—" until loaded: a missing figure is not zero. */
export function totalTakenLabel(balance) {
  return balance?.total == null ? "—" : `${balance.total} days`;
}

export function totalTakenSub(balance) {
  return balance?.year == null ? "Days taken this year" : `Days taken in ${balance.year}`;
}
