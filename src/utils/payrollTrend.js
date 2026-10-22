const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const monthIndex = (name) => MONTHS.findIndex((month) => month.toLowerCase() === String(name || "").trim().toLowerCase());

// Net pay disbursed in each of the last `count` calendar months ending with `now`'s month, from the payroll records
// themselves. Only processed records count as disbursed. `hasData` is false when no month in the window has any, so the
// dashboard can say so instead of drawing a flat line (it used to draw a fixed, made-up series).
export const payrollTrend = (payroll, now = new Date(), count = 6) => {
  const months = Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1);
    return { key: `${date.getFullYear()}-${date.getMonth()}`, m: MONTHS[date.getMonth()].slice(0, 3), total: 0, hasData: false };
  });
  const byKey = new Map(months.map((month) => [month.key, month]));

  (Array.isArray(payroll) ? payroll : []).forEach((record) => {
    if (record?.status !== "processed") return;
    const index = monthIndex(record.month);
    const year = Number(record.year);
    const net = Number(record.net);
    if (index < 0 || !Number.isFinite(year) || !Number.isFinite(net)) return;
    const month = byKey.get(`${year}-${index}`);
    if (!month) return;
    month.total += net;
    month.hasData = true;
  });

  return { data: months.map(({ m, total }) => ({ m, total })), hasData: months.some((month) => month.hasData) };
};
