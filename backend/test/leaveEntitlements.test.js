import assert from "node:assert/strict";
import test from "node:test";
import {
  DECEMBER_BONUS,
  LEAVE_TYPES,
  LEAVE_TYPE_POOL,
  MAX_LEAVE_DAYS,
  MONTHLY_ALLOWANCE,
  POOLS,
  SERIOUS_NEED_ALLOWANCE,
  computeBalance,
  daysBetweenInclusive,
  findOverage,
  monthlyEntitlement,
  monthlyUsage,
  seriousNeedEntitlement,
  seriousNeedUsage,
  splitDaysByMonth,
  yearsSpannedBy,
} from "../src/services/leaveEntitlements.js";

// No database, no clock. This module is the single home of management's entitlement rules (D4,
// D31) and every rule in it is pure, so this file is the exhaustive check of the arithmetic. The
// view that supplies `usage` is proved against real Postgres by scripts/e2e-leaves.js.

const usageRow = (type, year, month, approved, pending = 0) => ({
  type, usage_year: year, usage_month: month, days_approved: approved, days_pending: pending,
});

const LONG_EMPLOYED = "2020-01-01";
const fits = (overrides) => findOverage({ joinedOn: LONG_EMPLOYED, usage: [], ...overrides });

// ---------------------------------------------------------------------------
// The numbers and the type-to-pool map
// ---------------------------------------------------------------------------

test("management's numbers: 2 per month, 10 more in December, 14 per year", () => {
  assert.equal(MONTHLY_ALLOWANCE, 2);
  assert.equal(DECEMBER_BONUS, 10);
  assert.equal(SERIOUS_NEED_ALLOWANCE, 14);
});

test("the leave types are the five the UI and the enum offer", () => {
  assert.deepEqual([...LEAVE_TYPES], ["Annual", "Sick", "Casual", "Maternity", "Emergency"]);
});

test("the type-to-pool map: Annual and Casual draw on the monthly pool, Sick and Emergency on the serious-need pool, Maternity on none", () => {
  assert.equal(LEAVE_TYPE_POOL.Annual, POOLS.MONTHLY);
  assert.equal(LEAVE_TYPE_POOL.Casual, POOLS.MONTHLY);
  assert.equal(LEAVE_TYPE_POOL.Sick, POOLS.SERIOUS_NEED);
  assert.equal(LEAVE_TYPE_POOL.Emergency, POOLS.SERIOUS_NEED);
  assert.equal(LEAVE_TYPE_POOL.Maternity, null);
});

test("every leave type has an entry in the map -- none can fall through to 'unknown'", () => {
  for (const type of LEAVE_TYPES) assert.ok(Object.hasOwn(LEAVE_TYPE_POOL, type), type);
  assert.equal(Object.keys(LEAVE_TYPE_POOL).length, LEAVE_TYPES.length);
});

test("MAX_LEAVE_DAYS is a defensive 366, not a management rule", () => {
  assert.equal(MAX_LEAVE_DAYS, 366);
});

// ---------------------------------------------------------------------------
// The per-day split across calendar months (D5)
// ---------------------------------------------------------------------------

test("splitDaysByMonth: a leave inside one month is a single part", () => {
  assert.deepEqual(splitDaysByMonth("2026-03-10", "2026-03-12"), [{ year: 2026, month: 3, days: 3 }]);
  assert.deepEqual(splitDaysByMonth("2026-03-15", "2026-03-15"), [{ year: 2026, month: 3, days: 1 }]);
});

test("splitDaysByMonth: 30 January to 2 February is 2 days of January and 2 of February, not 4 of January", () => {
  assert.deepEqual(splitDaysByMonth("2026-01-30", "2026-02-02"), [
    { year: 2026, month: 1, days: 2 },
    { year: 2026, month: 2, days: 2 },
  ]);
});

test("splitDaysByMonth: crosses a year boundary", () => {
  assert.deepEqual(splitDaysByMonth("2026-12-30", "2027-01-02"), [
    { year: 2026, month: 12, days: 2 },
    { year: 2027, month: 1, days: 2 },
  ]);
});

test("splitDaysByMonth: knows leap years -- 28 Feb to 1 Mar is 2 days of February in 2028 and 1 in 2027", () => {
  assert.deepEqual(splitDaysByMonth("2028-02-28", "2028-03-01"), [
    { year: 2028, month: 2, days: 2 },
    { year: 2028, month: 3, days: 1 },
  ]);
  assert.deepEqual(splitDaysByMonth("2027-02-28", "2027-03-01"), [
    { year: 2027, month: 2, days: 1 },
    { year: 2027, month: 3, days: 1 },
  ]);
});

test("splitDaysByMonth: spans many months, one part per month in calendar order", () => {
  const parts = splitDaysByMonth("2026-01-31", "2026-04-01");
  assert.deepEqual(parts, [
    { year: 2026, month: 1, days: 1 },
    { year: 2026, month: 2, days: 28 },
    { year: 2026, month: 3, days: 31 },
    { year: 2026, month: 4, days: 1 },
  ]);
});

test("the split always sums to the inclusive calendar-day count -- the number the generated days column holds", () => {
  for (const [start, end] of [
    ["2026-01-01", "2026-12-31"], ["2028-01-01", "2028-12-31"], ["2026-12-31", "2027-01-01"],
    ["2026-02-27", "2026-03-02"], ["2026-07-04", "2026-07-04"],
  ]) {
    const total = splitDaysByMonth(start, end).reduce((sum, part) => sum + part.days, 0);
    assert.equal(total, daysBetweenInclusive(start, end), `${start}..${end}`);
  }
});

test("daysBetweenInclusive: counts both ends, and a leap year has 366 days", () => {
  assert.equal(daysBetweenInclusive("2026-03-10", "2026-03-10"), 1);
  assert.equal(daysBetweenInclusive("2026-03-10", "2026-03-12"), 3);
  assert.equal(daysBetweenInclusive("2026-01-01", "2026-12-31"), 365);
  assert.equal(daysBetweenInclusive("2028-01-01", "2028-12-31"), 366);
});

test("the date arithmetic is UTC-only: it gives the same answer whatever the process timezone", () => {
  // pg returns a `date` as a local-midnight Date; this module never touches one. Daylight-saving
  // transitions fall inside these ranges in many zones, so a local-time implementation would drift.
  assert.equal(daysBetweenInclusive("2026-03-01", "2026-04-01"), 32);
  assert.equal(daysBetweenInclusive("2026-10-01", "2026-11-01"), 32);
  assert.deepEqual(splitDaysByMonth("2026-03-28", "2026-04-02"), [
    { year: 2026, month: 3, days: 4 },
    { year: 2026, month: 4, days: 2 },
  ]);
});

test("yearsSpannedBy: the distinct calendar years a leave touches, ascending", () => {
  assert.deepEqual(yearsSpannedBy("2026-03-01", "2026-03-05"), [2026]);
  assert.deepEqual(yearsSpannedBy("2026-12-30", "2027-01-02"), [2026, 2027]);
  assert.deepEqual(yearsSpannedBy("2026-12-30", "2028-01-02"), [2026, 2027, 2028]);
});

// ---------------------------------------------------------------------------
// Entitlement per month and per year
// ---------------------------------------------------------------------------

test("monthlyEntitlement: 2 in an ordinary month", () => {
  for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.equal(monthlyEntitlement(2026, month, LONG_EMPLOYED), 2, `month ${month}`);
  }
});

test("monthlyEntitlement: December's allowance is 12 -- the monthly 2 plus the Christmas 10", () => {
  assert.equal(monthlyEntitlement(2026, 12, LONG_EMPLOYED), 12);
  assert.equal(monthlyEntitlement(2026, 12, LONG_EMPLOYED), MONTHLY_ALLOWANCE + DECEMBER_BONUS);
});

test("monthlyEntitlement: the Christmas 10 belong to December only -- no other month gets a bonus", () => {
  for (let month = 1; month <= 11; month += 1) {
    assert.ok(monthlyEntitlement(2026, month, LONG_EMPLOYED) < 12, `month ${month}`);
  }
});

test("monthlyEntitlement: no proration -- the month an employee joins carries the full 2, whatever the day", () => {
  assert.equal(monthlyEntitlement(2026, 3, "2026-03-01"), 2);
  assert.equal(monthlyEntitlement(2026, 3, "2026-03-15"), 2);
  assert.equal(monthlyEntitlement(2026, 3, "2026-03-31"), 2);
});

test("monthlyEntitlement: months before the month containing joined_on carry nothing", () => {
  assert.equal(monthlyEntitlement(2026, 2, "2026-03-15"), 0);
  assert.equal(monthlyEntitlement(2025, 12, "2026-03-15"), 0);
  assert.equal(monthlyEntitlement(2026, 3, "2026-03-15"), 2);
  assert.equal(monthlyEntitlement(2026, 4, "2026-03-15"), 2);
});

test("monthlyEntitlement: a mid-year joiner still gets the full Christmas 10", () => {
  assert.equal(monthlyEntitlement(2026, 12, "2026-06-20"), 12);
  assert.equal(monthlyEntitlement(2026, 12, "2026-11-30"), 12);
  assert.equal(monthlyEntitlement(2026, 12, "2026-12-31"), 12, "joined in December itself");
});

test("monthlyEntitlement: someone who joins the following January has no December that year", () => {
  assert.equal(monthlyEntitlement(2026, 12, "2027-01-01"), 0);
});

test("seriousNeedEntitlement: the full 14 for every calendar year employed, never prorated", () => {
  assert.equal(seriousNeedEntitlement(2026, "2020-01-01"), 14);
  assert.equal(seriousNeedEntitlement(2026, "2026-01-01"), 14);
  assert.equal(seriousNeedEntitlement(2026, "2026-12-31"), 14, "joined on the last day of the year");
  assert.equal(seriousNeedEntitlement(2030, "2026-06-01"), 14, "granted every year, not once in a lifetime");
});

test("seriousNeedEntitlement: nothing before the year the employee joined", () => {
  assert.equal(seriousNeedEntitlement(2025, "2026-01-01"), 0);
});

// ---------------------------------------------------------------------------
// Usage by pool
// ---------------------------------------------------------------------------

test("monthlyUsage: sums Annual and Casual in that month only -- one shared pool", () => {
  const usage = [
    usageRow("Annual", 2026, 3, 1, 0),
    usageRow("Casual", 2026, 3, 0, 1),
    usageRow("Annual", 2026, 4, 2, 0),       // another month
    usageRow("Annual", 2025, 3, 2, 0),       // the same month, another year
    usageRow("Sick", 2026, 3, 5, 0),         // another pool entirely
    usageRow("Maternity", 2026, 3, 30, 0),   // no pool
  ];
  assert.deepEqual(monthlyUsage(usage, 2026, 3), { approved: 1, pending: 1 });
});

test("seriousNeedUsage: sums Sick and Emergency across every month of the calendar year", () => {
  const usage = [
    usageRow("Sick", 2026, 1, 4, 0),
    usageRow("Emergency", 2026, 8, 2, 1),
    usageRow("Sick", 2027, 1, 9, 0),         // another year
    usageRow("Annual", 2026, 2, 2, 0),       // another pool
  ];
  assert.deepEqual(seriousNeedUsage(usage, 2026), { approved: 6, pending: 1 });
});

test("usage accepts numeric strings, as a driver may return them", () => {
  assert.deepEqual(monthlyUsage([usageRow("Annual", 2026, 3, "2", "0")], 2026, 3), { approved: 2, pending: 0 });
});

// ---------------------------------------------------------------------------
// findOverage: the over-balance rule
// ---------------------------------------------------------------------------

test("findOverage: 2 days fit a month, 3 do not", () => {
  assert.equal(fits({ type: "Annual", startDate: "2026-03-10", endDate: "2026-03-11" }), null);

  const overage = fits({ type: "Annual", startDate: "2026-03-10", endDate: "2026-03-12" });
  assert.deepEqual(overage, {
    pool: "monthly", period: { year: 2026, month: 3 }, entitlement: 2, used: 0, requested: 3, remaining: 2,
  });
});

test("findOverage: a pending request RESERVES its days, so requests cannot be stacked past the allowance", () => {
  const overage = fits({
    usage: [usageRow("Annual", 2026, 3, 0, 2)], type: "Annual", startDate: "2026-03-20", endDate: "2026-03-20",
  });
  assert.equal(overage.used, 2);
  assert.equal(overage.remaining, 0);
});

test("findOverage: approved and pending both count toward 'used'", () => {
  const overage = fits({
    usage: [usageRow("Annual", 2026, 3, 1, 1)], type: "Annual", startDate: "2026-03-20", endDate: "2026-03-20",
  });
  assert.equal(overage.used, 2);
});

test("findOverage: Annual and Casual share the one monthly pool", () => {
  const overage = fits({
    usage: [usageRow("Annual", 2026, 3, 2)], type: "Casual", startDate: "2026-03-20", endDate: "2026-03-20",
  });
  assert.equal(overage?.pool, "monthly");
  assert.equal(overage?.used, 2);
});

test("findOverage: the monthly pool does not carry forward -- a fresh month starts at 2 again", () => {
  assert.equal(fits({
    usage: [usageRow("Annual", 2026, 3, 2)], type: "Annual", startDate: "2026-04-01", endDate: "2026-04-02",
  }), null);
});

test("findOverage: unused monthly days do not carry forward either -- nothing banked from a quiet month", () => {
  // March was untouched, but that does not make April's allowance 4.
  assert.ok(fits({ type: "Annual", startDate: "2026-04-01", endDate: "2026-04-03" }));
});

test("findOverage: December's allowance is 12 -- 12 days fit, 13 do not", () => {
  assert.equal(fits({ type: "Annual", startDate: "2026-12-01", endDate: "2026-12-12" }), null);

  const overage = fits({ type: "Annual", startDate: "2026-12-01", endDate: "2026-12-13" });
  assert.equal(overage?.entitlement, 12);
  assert.equal(overage?.requested, 13);
  assert.deepEqual(overage?.period, { year: 2026, month: 12 });
});

test("findOverage: December is 12 TOTAL across Annual and Casual, not 12 each", () => {
  const usage = [usageRow("Annual", 2026, 12, 8), usageRow("Casual", 2026, 12, 2)];
  assert.equal(fits({ usage, type: "Annual", startDate: "2026-12-20", endDate: "2026-12-21" }), null);
  assert.ok(fits({ usage, type: "Annual", startDate: "2026-12-20", endDate: "2026-12-22" }));
});

test("findOverage: a leave spanning two months is checked against EACH month's own allowance", () => {
  // 30 Jan - 2 Feb is 2 + 2: it fits, though 4 days would never fit one month.
  assert.equal(fits({ type: "Annual", startDate: "2026-01-30", endDate: "2026-02-02" }), null);
});

test("findOverage: a spanning leave is refused when the SECOND month is already used, and names that month", () => {
  const overage = fits({
    usage: [usageRow("Annual", 2026, 2, 1)], type: "Annual", startDate: "2026-01-30", endDate: "2026-02-02",
  });
  assert.deepEqual(overage?.period, { year: 2026, month: 2 });
  assert.equal(overage?.requested, 2);
  assert.equal(overage?.remaining, 1);
});

test("findOverage: a spanning leave is refused when the FIRST month is the one that is full", () => {
  const overage = fits({
    usage: [usageRow("Annual", 2026, 1, 2)], type: "Annual", startDate: "2026-01-30", endDate: "2026-02-02",
  });
  assert.deepEqual(overage?.period, { year: 2026, month: 1 });
});

test("findOverage: a leave that runs into December picks up December's 12 for its December days", () => {
  // 29 Nov - 5 Dec is 2 days of November (the limit) and 5 of December (well inside 12).
  assert.equal(fits({ type: "Annual", startDate: "2026-11-29", endDate: "2026-12-05" }), null);
  // One more November day and November overflows.
  assert.equal(fits({ type: "Annual", startDate: "2026-11-28", endDate: "2026-12-05" })?.period.month, 11);
});

test("findOverage: a leave in a month before joined_on has no entitlement at all", () => {
  const overage = findOverage({
    joinedOn: "2026-06-01", usage: [], type: "Annual", startDate: "2026-05-10", endDate: "2026-05-10",
  });
  assert.equal(overage?.entitlement, 0);
  assert.equal(overage?.remaining, 0);
});

test("findOverage: the month of joining is the full 2, with no proration", () => {
  assert.equal(findOverage({
    joinedOn: "2026-06-25", usage: [], type: "Annual", startDate: "2026-06-26", endDate: "2026-06-27",
  }), null);
});

test("findOverage: D31 -- Maternity is outside the pools, so it is exempt however long and however full they are", () => {
  assert.equal(fits({ type: "Maternity", startDate: "2026-01-01", endDate: "2026-12-31" }), null);

  const fullPools = [
    usageRow("Annual", 2026, 3, 2), usageRow("Sick", 2026, 3, 14), usageRow("Emergency", 2026, 4, 0),
  ];
  assert.equal(fits({ usage: fullPools, type: "Maternity", startDate: "2026-03-01", endDate: "2026-03-31" }), null);
});

test("findOverage: Maternity usage never consumes a pool", () => {
  // A long approved Maternity leave sits in the view but is on no pool, so it takes nothing from March's 2.
  const usage = [usageRow("Maternity", 2026, 3, 31)];
  assert.equal(fits({ usage, type: "Annual", startDate: "2026-03-10", endDate: "2026-03-11" }), null);
  assert.equal(fits({ usage, type: "Sick", startDate: "2026-03-10", endDate: "2026-03-23" }), null);
});

test("findOverage: serious-need is 14 per calendar year -- 14 fit, 15 do not", () => {
  assert.equal(fits({ type: "Emergency", startDate: "2026-03-01", endDate: "2026-03-14" }), null);

  const overage = fits({ type: "Sick", startDate: "2026-03-01", endDate: "2026-03-15" });
  assert.deepEqual(overage, {
    pool: "serious_need", period: { year: 2026 }, entitlement: 14, used: 0, requested: 15, remaining: 14,
  });
});

test("findOverage: Sick and Emergency share the one yearly pool across all its months", () => {
  const usage = [usageRow("Sick", 2026, 1, 10), usageRow("Emergency", 2026, 2, 3)];
  const overage = fits({ usage, type: "Sick", startDate: "2026-06-01", endDate: "2026-06-02" });
  assert.equal(overage?.used, 13);
  assert.equal(overage?.remaining, 1);
});

test("findOverage: serious-need is granted EVERY year -- last year's use does not reduce this year's 14", () => {
  const usage = [usageRow("Sick", 2025, 5, 14)];
  assert.equal(fits({ usage, type: "Sick", startDate: "2026-01-05", endDate: "2026-01-18" }), null);
});

test("findOverage: serious-need is attributed per calendar YEAR when a leave spans a year boundary", () => {
  const usage = [usageRow("Sick", 2027, 1, 13)];
  const overage = fits({ usage, type: "Sick", startDate: "2026-12-31", endDate: "2027-01-02" });
  assert.deepEqual(overage?.period, { year: 2027 });
  assert.equal(overage?.requested, 2, "only the 2027 days are charged to 2027");
});

test("findOverage: serious-need pending requests reserve their days too", () => {
  const usage = [usageRow("Sick", 2026, 3, 0, 14)];
  assert.ok(fits({ usage, type: "Emergency", startDate: "2026-09-01", endDate: "2026-09-01" }));
});

test("findOverage: the two pools are independent -- filling one never blocks the other", () => {
  const monthlyFull = [usageRow("Annual", 2026, 3, 2)];
  assert.equal(fits({ usage: monthlyFull, type: "Sick", startDate: "2026-03-10", endDate: "2026-03-12" }), null);
  const seriousFull = [usageRow("Sick", 2026, 3, 14)];
  assert.equal(fits({ usage: seriousFull, type: "Annual", startDate: "2026-03-10", endDate: "2026-03-11" }), null);
});

test("findOverage: an unknown type throws rather than being silently exempt", () => {
  assert.throws(
    () => fits({ type: "Sabbatical", startDate: "2026-01-01", endDate: "2026-01-01" }),
    /Unknown leave type: Sabbatical/,
  );
});

// ---------------------------------------------------------------------------
// computeBalance
// ---------------------------------------------------------------------------

test("computeBalance: the monthly pool for the as-of month and the serious-need pool for the as-of year", () => {
  const balance = computeBalance({
    joinedOn: LONG_EMPLOYED,
    usage: [
      usageRow("Annual", 2026, 3, 1, 1),
      usageRow("Annual", 2026, 4, 2),                 // another month: not in March's pool
      usageRow("Sick", 2026, 1, 5),
      usageRow("Emergency", 2026, 11, 2, 1),
    ],
    asOf: "2026-03-15",
  });

  assert.equal(balance.as_of, "2026-03-15");
  assert.deepEqual(balance.pools.monthly, {
    period: { year: 2026, month: 3 }, entitlement: 2, approved: 1, pending: 1, remaining: 0,
  });
  assert.deepEqual(balance.pools.serious_need, {
    period: { year: 2026 }, entitlement: 14, approved: 7, pending: 1, remaining: 6,
  });
});

test("computeBalance: December reports an allowance of 12", () => {
  const balance = computeBalance({ joinedOn: LONG_EMPLOYED, usage: [usageRow("Annual", 2026, 12, 3, 1)], asOf: "2026-12-10" });
  assert.equal(balance.pools.monthly.entitlement, 12);
  assert.equal(balance.pools.monthly.remaining, 8);
});

test("computeBalance: the type map covers all five types and gives Maternity no pool", () => {
  const { types } = computeBalance({ joinedOn: LONG_EMPLOYED, usage: [], asOf: "2026-03-15" });
  assert.deepEqual(types, {
    Annual: "monthly", Sick: "serious_need", Casual: "monthly", Maternity: null, Emergency: "serious_need",
  });
});

test("computeBalance: before joining there is nothing to spend", () => {
  const balance = computeBalance({ joinedOn: "2026-06-15", usage: [], asOf: "2026-05-10" });
  assert.equal(balance.pools.monthly.entitlement, 0);
  assert.equal(balance.pools.serious_need.entitlement, 14, "the joining year's 14 is full, even before the joining month");
});

test("computeBalance: remaining is NOT clamped -- an over-used month, such as an imported leave, shows negative", () => {
  const balance = computeBalance({ joinedOn: LONG_EMPLOYED, usage: [usageRow("Annual", 2026, 3, 5)], asOf: "2026-03-01" });
  assert.equal(balance.pools.monthly.remaining, -3);
});

test("computeBalance: Maternity usage appears in no pool", () => {
  const balance = computeBalance({ joinedOn: LONG_EMPLOYED, usage: [usageRow("Maternity", 2026, 3, 31, 0)], asOf: "2026-03-15" });
  assert.equal(balance.pools.monthly.approved + balance.pools.monthly.pending, 0);
  assert.equal(balance.pools.serious_need.approved + balance.pools.serious_need.pending, 0);
});

test("computeBalance: a leave that spans a month boundary shows in BOTH months' balances", () => {
  // As the view delivers it: 30 Jan - 2 Feb already split into a January row and a February row.
  const usage = [usageRow("Annual", 2026, 1, 0, 2), usageRow("Annual", 2026, 2, 0, 2)];
  assert.equal(computeBalance({ joinedOn: LONG_EMPLOYED, usage, asOf: "2026-01-31" }).pools.monthly.pending, 2);
  assert.equal(computeBalance({ joinedOn: LONG_EMPLOYED, usage, asOf: "2026-02-01" }).pools.monthly.pending, 2);
  assert.equal(computeBalance({ joinedOn: LONG_EMPLOYED, usage, asOf: "2026-03-01" }).pools.monthly.pending, 0);
});
