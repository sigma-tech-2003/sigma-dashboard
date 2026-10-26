// What the dashboard shows, worked out from the collections the app already loads. Pure functions: no React, no clock of
// their own (every one takes `now`), so each can be tested with a fixed date. The page only arranges what these return.
import { attendanceDateValue, latestAttendanceRecords, normalizeAttendanceStatus } from "../../utils/attendanceSummary.js";
import { getKpiRatingSummary, isValidProjectKpiScore } from "../../utils/helpers.js";

const DAY = 86400000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

export const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const parseIso = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysBetween = (fromIso, toDate) => Math.round((startOfDay(toDate) - parseIso(fromIso)) / DAY);
const dayIndex = (iso, start) => Math.round((parseIso(iso) - startOfDay(start)) / DAY);
const isActive = (employee) => employee && employee.id != null && normalizeAttendanceStatus(employee.status) === "active";
const nameOf = (employee) => employee?.name || employee?.email || "Unnamed employee";

// ---- Here today ---------------------------------------------------------------------------------------------------

// Each active person, and whether they are in, out (leave or absent) or not yet in, from today's latest attendance record.
export const presenceToday = (employees, attendance, now) => {
  const active = (Array.isArray(employees) ? employees : []).filter(isActive);
  const ids = new Set(active.map((employee) => String(employee.id)));
  const records = new Map(latestAttendanceRecords(attendance, ids, isoOf(now)).map((record) => [String(record.empId), record]));

  const people = active.map((employee) => {
    const record = records.get(String(employee.id));
    const status = record ? normalizeAttendanceStatus(record.status) : "";
    const state = status === "present" || status === "late" ? "in" : status === "leave" || status === "absent" ? "out" : "not";
    return { employee, state, status: status || null, late: status === "late", checkIn: record?.checkIn || "" };
  });
  const counts = { in: 0, out: 0, not: 0, total: people.length };
  people.forEach((person) => { counts[person.state] += 1; });
  return { people, counts };
};

// The next `count` working days (today first, unless today is a weekend) and how many people are expected in on each.
// Today uses who actually clocked in; later days use headcount minus approved leave.
export const weekAhead = (employees, leaves, presence, now, count = 5) => {
  const active = (Array.isArray(employees) ? employees : []).filter(isActive);
  const approved = (Array.isArray(leaves) ? leaves : []).filter((leave) => normalizeAttendanceStatus(leave.status) === "approved");
  const todayIso = isoOf(now);
  const out = [];
  for (let offset = 0; out.length < count && offset < 14; offset += 1) {
    const day = addDays(now, offset);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const iso = isoOf(day);
    const away = new Set(approved.filter((leave) => {
      const from = attendanceDateValue(leave.start);
      const to = attendanceDateValue(leave.end) || from;
      return from && from <= iso && to >= iso;
    }).map((leave) => String(leave.empId)));
    const awayActive = active.filter((employee) => away.has(String(employee.id))).length;
    out.push({
      iso,
      label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.getDay()],
      today: iso === todayIso,
      count: iso === todayIso && presence ? presence.counts.in : active.length - awayActive,
      total: active.length,
    });
  }
  return out;
};

// ---- Who is away --------------------------------------------------------------------------------------------------

// A calendar of approved and waiting leave over `days` days from `start`: columns for the days, one row per person with
// a bar per leave (clipped to the window). Rows are ordered by whose leave starts first.
export const awayCalendar = (leaves, employees, start, days = 14) => {
  const origin = startOfDay(start);
  const columns = Array.from({ length: days }, (_, index) => {
    const date = addDays(origin, index);
    return { iso: isoOf(date), n: date.getDate(), weekday: "MTWTFSS"[(date.getDay() + 6) % 7], weekend: date.getDay() === 0 || date.getDay() === 6, today: index === 0 };
  });
  const first = columns[0].iso;
  const last = columns[days - 1].iso;
  const people = new Map((Array.isArray(employees) ? employees : []).map((employee) => [String(employee.id), employee]));
  const rows = new Map();

  (Array.isArray(leaves) ? leaves : []).forEach((leave) => {
    const status = normalizeAttendanceStatus(leave.status);
    if (status !== "approved" && status !== "pending") return;
    const from = attendanceDateValue(leave.start);
    const to = attendanceDateValue(leave.end) || from;
    const employee = people.get(String(leave.empId));
    if (!from || !employee || to < from || to < first || from > last) return;

    const row = rows.get(String(employee.id)) || { employee, bars: [] };
    row.bars.push({
      id: String(leave.id ?? leave._docId ?? `${leave.empId}-${from}`),
      type: leave.type || "Leave",
      status,
      start: Math.max(0, dayIndex(from, origin)),
      end: Math.min(days - 1, dayIndex(to, origin)),
      from,
      to,
    });
    rows.set(String(employee.id), row);
  });

  const ordered = [...rows.values()].sort((a, b) =>
    Math.min(...a.bars.map((bar) => bar.start)) - Math.min(...b.bars.map((bar) => bar.start)) || nameOf(a.employee).localeCompare(nameOf(b.employee)));
  return { columns, rows: ordered, hasAny: ordered.length > 0 };
};

// ---- Needs you ----------------------------------------------------------------------------------------------------

// Leave waiting for a decision, oldest first. `leaves` is already limited to what this person may decide.
export const decisionItems = (leaves, employees, now) => {
  const people = new Map((Array.isArray(employees) ? employees : []).map((employee) => [String(employee.id), employee]));
  return (Array.isArray(leaves) ? leaves : [])
    .filter((leave) => normalizeAttendanceStatus(leave.status) === "pending" && people.has(String(leave.empId)))
    .map((leave) => {
      const applied = attendanceDateValue(leave.applied) || attendanceDateValue(leave.createdAt) || attendanceDateValue(leave.start);
      return {
        kind: "leave",
        key: `leave:${leave.id ?? leave._docId}`,
        id: leave.id ?? leave._docId,
        employee: people.get(String(leave.empId)),
        type: leave.type || "Leave",
        from: attendanceDateValue(leave.start),
        to: attendanceDateValue(leave.end) || attendanceDateValue(leave.start),
        days: Number(leave.days) || 1,
        reason: typeof leave.reason === "string" ? leave.reason.trim() : "",
        waitDays: applied ? Math.max(0, daysBetween(applied, now)) : 0,
        applied,
      };
    })
    .sort((a, b) => (a.applied || "").localeCompare(b.applied || "") || a.key.localeCompare(b.key));
};

// KPIs with no valid rating yet, grouped by person: who is waiting to be rated.
export const awaitingRating = (kpis, employees) => {
  const people = new Map((Array.isArray(employees) ? employees : []).map((employee) => [String(employee.id), employee]));
  const counts = new Map();
  (Array.isArray(kpis) ? kpis : []).forEach((kpi) => {
    if (kpi.empId == null || !people.has(String(kpi.empId)) || isValidProjectKpiScore(kpi.rating)) return;
    counts.set(String(kpi.empId), (counts.get(String(kpi.empId)) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([id, unrated]) => ({ employee: people.get(id), unrated }))
    .sort((a, b) => b.unrated - a.unrated || nameOf(a.employee).localeCompare(nameOf(b.employee)));
};

// ---- Payroll ------------------------------------------------------------------------------------------------------

const monthIndexOf = (name) => MONTHS.findIndex((month) => month.toLowerCase() === String(name || "").trim().toLowerCase());
const recordsOf = (payroll, monthIndex, year) => (Array.isArray(payroll) ? payroll : [])
  .filter((record) => monthIndexOf(record?.month) === monthIndex && Number(record?.year) === year);
const processedNet = (records) => records.filter((record) => record.status === "processed").reduce((sum, record) => sum + (Number(record.net) || 0), 0);

// This month's payroll (or the latest month that has any), what has been paid, what is still in draft, and the change on
// the month before. `stage` says where the cycle is: none, review (drafts remain) or done.
export const payrollSnapshot = (payroll, now) => {
  const all = (Array.isArray(payroll) ? payroll : []).filter((record) => monthIndexOf(record?.month) >= 0 && Number.isFinite(Number(record?.year)));
  let monthIndex = now.getMonth();
  let year = now.getFullYear();
  if (!recordsOf(all, monthIndex, year).length && all.length) {
    const latest = all.reduce((best, record) => {
      const key = Number(record.year) * 12 + monthIndexOf(record.month);
      return key > best ? key : best;
    }, -1);
    year = Math.floor(latest / 12);
    monthIndex = latest % 12;
  }
  const records = recordsOf(all, monthIndex, year);
  const processed = records.filter((record) => record.status === "processed");
  const drafts = records.filter((record) => record.status === "draft");
  const previous = processedNet(recordsOf(all, (monthIndex + 11) % 12, monthIndex === 0 ? year - 1 : year));
  const total = processedNet(records);

  return {
    monthName: MONTHS[monthIndex],
    year,
    isCurrent: monthIndex === now.getMonth() && year === now.getFullYear(),
    total,
    processed: processed.length,
    drafts: drafts.length,
    stage: drafts.length ? "review" : processed.length ? "done" : "none",
    changePct: previous > 0 ? Math.round((total / previous - 1) * 1000) / 10 : null,
  };
};

// What payroll needs from the person (admin or HR) right now, if anything.
export const payrollNeed = (payroll, now) => {
  const snapshot = payrollSnapshot(payroll, now);
  const startedThisMonth = snapshot.isCurrent && snapshot.processed + snapshot.drafts > 0;
  if (!startedThisMonth) {
    const onRecord = snapshot.processed + snapshot.drafts > 0;
    return {
      kind: "payroll",
      key: "payroll",
      title: `${MONTHS[now.getMonth()]} payroll has not been started`,
      note: onRecord ? `The latest payroll on record is ${snapshot.monthName} ${snapshot.year}.` : "No payroll record exists yet.",
      chip: "Not started",
    };
  }
  if (snapshot.drafts) {
    return {
      kind: "payroll",
      key: "payroll",
      title: `${snapshot.drafts} payroll ${snapshot.drafts === 1 ? "record is" : "records are"} still in draft`,
      note: `${snapshot.monthName} payroll is not finished until these are processed.`,
      chip: "In review",
    };
  }
  return null;
};

// ---- People and performance ---------------------------------------------------------------------------------------

export const peopleSnapshot = (employees, now) => {
  const active = (Array.isArray(employees) ? employees : []).filter(isActive);
  const byDept = new Map();
  active.forEach((employee) => byDept.set(employee.dept || "No department", (byDept.get(employee.dept || "No department") || 0) + 1));
  const groups = [...byDept.entries()]
    .map(([name, count]) => ({ name, count, pct: active.length ? (count / active.length) * 100 : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const joined = active
    .map((employee) => ({ employee, joinedOn: attendanceDateValue(employee.joinDate) }))
    .filter((entry) => entry.joinedOn)
    .map((entry) => ({ ...entry, daysAgo: daysBetween(entry.joinedOn, now) }))
    .filter((entry) => entry.daysAgo >= 0)
    .sort((a, b) => a.daysAgo - b.daysAgo);
  const recent = joined.filter((entry) => entry.daysAgo <= 30);

  return { total: active.length, groups, joiners: recent.slice(0, 3), joinedRecently: recent.length, latestJoiner: joined[0] || null };
};

export const performanceSnapshot = (kpis, employees) => {
  const people = (Array.isArray(employees) ? employees : []).filter((employee) => employee?.id != null);
  const list = Array.isArray(kpis) ? kpis : [];
  const rows = people
    .map((employee) => {
      const own = list.filter((kpi) => kpi.empId != null && String(kpi.empId) === String(employee.id));
      if (!own.length) return null;
      const summary = getKpiRatingSummary(own);
      return { employee, rating: summary.average, unrated: summary.totalCount - summary.ratedCount };
    })
    .filter(Boolean)
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || nameOf(a.employee).localeCompare(nameOf(b.employee)));
  const overall = getKpiRatingSummary(list.filter((kpi) => kpi.empId != null && people.some((employee) => String(employee.id) === String(kpi.empId))));
  return { average: overall.average, ratedCount: overall.ratedCount, totalCount: overall.totalCount, people: rows, peopleRated: rows.filter((row) => row.rating !== null).length };
};

// ---- Greeting -----------------------------------------------------------------------------------------------------

export const greetingFor = (now) => (now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening");

export const waitingLabel = (days) => (days <= 0 ? "Applied today" : days === 1 ? "Waiting 1 day" : `Waiting ${days} days`);

// ---- Dates for display --------------------------------------------------------------------------------------------

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const formatDay = (iso) => {
  if (!iso) return "";
  const date = parseIso(iso);
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
};

export const formatRange = (from, to) => (!to || from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`);

export const longDate = (date) => `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
