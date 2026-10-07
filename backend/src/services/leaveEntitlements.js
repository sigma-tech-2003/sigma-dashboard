/**
 * Leave entitlement: the numbers, the leave-type-to-pool map, and the pure rules built on them.
 * Everything management decided about how much leave an employee gets lives HERE and nowhere else
 * (D4, D31) -- not in the database and not scattered through services -- so a change to the rules
 * is a change to this one module.
 *
 * Pure: no I/O, no clock, no database. Dates are `YYYY-MM-DD` strings throughout and are handled
 * with UTC arithmetic only, because pg returns a `date` as a local-midnight JS Date and any
 * local-time getter on one is a latent off-by-one on a server east of UTC.
 *
 * The three pools (D4, as relayed by management on 2026-10-07):
 *  - monthly      2 leaves per calendar month, NOT carried forward; December's allowance is 12,
 *                 the Christmas 10 being usable only in December.
 *  - serious_need 14 leaves per calendar year (Hajj, Umrah, illness or similar serious need),
 *                 granted every year, not once in a lifetime, with no proof requirement.
 *  - (none)       Maternity sits outside the pools and is uncapped -- an INTERIM: none of the three
 *                 rules mentions it, so management still has to supply a figure (D31, open item).
 * No proration anywhere: a joiner gets the full monthly 2 for every month employed, the full 14 for
 * every calendar year employed, and the full 10 however late in the year they joined.
 */

export const MONTHLY_ALLOWANCE = 2;
export const DECEMBER_BONUS = 10;
export const SERIOUS_NEED_ALLOWANCE = 14;

/**
 * The longest single request, in calendar days. NOT a management rule (D31 does not set one): a
 * defensive bound so an absurd date range cannot make the usage view generate millions of rows.
 * A year-long Maternity request, the longest plausible one, fits.
 */
export const MAX_LEAVE_DAYS = 366;

export const POOLS = Object.freeze({ MONTHLY: "monthly", SERIOUS_NEED: "serious_need" });

export const LEAVE_TYPES = Object.freeze(["Annual", "Sick", "Casual", "Maternity", "Emergency"]);

/**
 * Which pool a leave type draws on. The five types are kept because the UI and the enum offer them;
 * management's pools do not line up with them one to one, so this fixed map bridges the two. Hajj and
 * Umrah are applied for as Emergency ("or similar serious need"). `null` means no pool.
 */
export const LEAVE_TYPE_POOL = Object.freeze({
  Annual: POOLS.MONTHLY,
  Casual: POOLS.MONTHLY,
  Sick: POOLS.SERIOUS_NEED,
  Emergency: POOLS.SERIOUS_NEED,
  Maternity: null,
});

const DAY_MS = 86_400_000;

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

const toUtcMs = (value) => {
  const { year, month, day } = parseDate(value);
  return Date.UTC(year, month - 1, day);
};

/** Inclusive calendar-day count -- the same number the generated `days` column holds. */
export function daysBetweenInclusive(startDate, endDate) {
  return (toUtcMs(endDate) - toUtcMs(startDate)) / DAY_MS + 1;
}

/**
 * Splits a leave per calendar day across the months it covers (D5): each day is charged to the month
 * it falls in. Returns `[{ year, month, days }]` in calendar order, so a leave from 30 January to
 * 2 February is `[{ 2026, 1, 2 }, { 2026, 2, 2 }]`. The days sum to `daysBetweenInclusive`.
 */
export function splitDaysByMonth(startDate, endDate) {
  const parts = [];
  const end = toUtcMs(endDate);
  for (let ms = toUtcMs(startDate); ms <= end; ms += DAY_MS) {
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const last = parts[parts.length - 1];
    if (last && last.year === year && last.month === month) last.days += 1;
    else parts.push({ year, month, days: 1 });
  }
  return parts;
}

/** The distinct calendar years a leave touches, ascending. */
export function yearsSpannedBy(startDate, endDate) {
  const first = parseDate(startDate).year;
  const last = parseDate(endDate).year;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * The monthly pool's allowance for one calendar month: 0 before the month that contains the
 * employee's `joined_on`, then 2 -- and 12 in December, the Christmas 10 on top. No proration: the
 * month an employee joins carries the full 2.
 */
export function monthlyEntitlement(year, month, joinedOn) {
  const joined = parseDate(joinedOn);
  if (year * 12 + month < joined.year * 12 + joined.month) return 0;
  return MONTHLY_ALLOWANCE + (month === 12 ? DECEMBER_BONUS : 0);
}

/** The serious-need pool's allowance for one calendar year: 0 before the joining year, else the full 14. */
export function seriousNeedEntitlement(year, joinedOn) {
  return year < parseDate(joinedOn).year ? 0 : SERIOUS_NEED_ALLOWANCE;
}

function sumUsage(usage, belongsToPool, matchesPeriod) {
  let approved = 0;
  let pending = 0;
  for (const row of usage) {
    if (LEAVE_TYPE_POOL[row.type] !== belongsToPool || !matchesPeriod(row)) continue;
    approved += Number(row.days_approved);
    pending += Number(row.days_pending);
  }
  return { approved, pending };
}

/** Days already charged to the monthly pool in one calendar month, split approved / pending. */
export function monthlyUsage(usage, year, month) {
  return sumUsage(usage, POOLS.MONTHLY, (row) => row.usage_year === year && row.usage_month === month);
}

/** Days already charged to the serious-need pool in one calendar year, split approved / pending. */
export function seriousNeedUsage(usage, year) {
  return sumUsage(usage, POOLS.SERIOUS_NEED, (row) => row.usage_year === year);
}

/**
 * Would this request push a pool over its allowance? Usage is approved PLUS pending -- a pending
 * request reserves its days -- so requests cannot be stacked past the allowance. A leave that spans
 * months is checked month by month against each month's own allowance (D5).
 *
 * Returns null when the request fits, or when its type draws on no pool (Maternity: exempt).
 * Otherwise returns the first overage found: `{ pool, period, entitlement, used, requested,
 * remaining }`, where `requested` is the days of THIS request that fall in that period.
 *
 * `usage` is rows of the employee_leave_usage view: `{ type, usage_year, usage_month, days_approved,
 * days_pending }`.
 */
export function findOverage({ type, startDate, endDate, joinedOn, usage }) {
  if (!Object.hasOwn(LEAVE_TYPE_POOL, type)) throw new Error(`Unknown leave type: ${type}`);
  const pool = LEAVE_TYPE_POOL[type];
  if (pool === null) return null;

  const parts = splitDaysByMonth(startDate, endDate);

  if (pool === POOLS.MONTHLY) {
    for (const { year, month, days } of parts) {
      const entitlement = monthlyEntitlement(year, month, joinedOn);
      const { approved, pending } = monthlyUsage(usage, year, month);
      const used = approved + pending;
      if (used + days > entitlement) {
        return { pool, period: { year, month }, entitlement, used, requested: days, remaining: Math.max(0, entitlement - used) };
      }
    }
    return null;
  }

  const requestedByYear = new Map();
  for (const { year, days } of parts) requestedByYear.set(year, (requestedByYear.get(year) ?? 0) + days);
  for (const [year, requested] of requestedByYear) {
    const entitlement = seriousNeedEntitlement(year, joinedOn);
    const { approved, pending } = seriousNeedUsage(usage, year);
    const used = approved + pending;
    if (used + requested > entitlement) {
      return { pool, period: { year }, entitlement, used, requested, remaining: Math.max(0, entitlement - used) };
    }
  }
  return null;
}

/**
 * An employee's balance as of a date: the monthly pool for that calendar month and the serious-need
 * pool for that calendar year, plus which pool each leave type draws on (`null` for Maternity, which
 * has none). `remaining` is `entitlement - approved - pending` and is NOT clamped at zero: a negative
 * figure is real information, for instance when an imported legacy leave exceeded today's allowance.
 */
export function computeBalance({ joinedOn, usage, asOf }) {
  const { year, month } = parseDate(asOf);

  const monthlyUsed = monthlyUsage(usage, year, month);
  const monthlyAllowance = monthlyEntitlement(year, month, joinedOn);
  const seriousUsed = seriousNeedUsage(usage, year);
  const seriousAllowance = seriousNeedEntitlement(year, joinedOn);

  return {
    as_of: asOf,
    pools: {
      [POOLS.MONTHLY]: {
        period: { year, month },
        entitlement: monthlyAllowance,
        approved: monthlyUsed.approved,
        pending: monthlyUsed.pending,
        remaining: monthlyAllowance - monthlyUsed.approved - monthlyUsed.pending,
      },
      [POOLS.SERIOUS_NEED]: {
        period: { year },
        entitlement: seriousAllowance,
        approved: seriousUsed.approved,
        pending: seriousUsed.pending,
        remaining: seriousAllowance - seriousUsed.approved - seriousUsed.pending,
      },
    },
    types: Object.fromEntries(LEAVE_TYPES.map((type) => [type, LEAVE_TYPE_POOL[type]])),
  };
}
