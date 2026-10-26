import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays, awaitingRating, awayCalendar, decisionItems, formatDay, formatRange, greetingFor, isoOf, longDate, payrollNeed, payrollSnapshot,
  peopleSnapshot, performanceSnapshot, presenceToday, waitingLabel, weekAhead,
} from "./dashboardData.js";

// Monday 26 October 2026, 09:00
const now = new Date(2026, 9, 26, 9, 0);
const E = [
  { id: "h", name: "Hanna Hussain", dept: "Administration", status: "active", joinDate: "2020-01-15" },
  { id: "e", name: "Esha Employee", dept: "Engineering", status: "active", joinDate: "2026-10-12" },
  { id: "b", name: "Bilal Raza", dept: "Engineering", status: "active", joinDate: "2024-03-01" },
  { id: "z", name: "Zara Hussain", dept: "Administration", status: "inactive", joinDate: "2022-08-10" },
];
const attendance = [
  { empId: "h", date: "2026-10-26", status: "present", checkIn: "08:52" },
  { empId: "e", date: "2026-10-26", status: "late", checkIn: "09:30" },
  { empId: "h", date: "2026-10-25", status: "absent" },
];
const leaves = [
  { id: "l1", empId: "e", type: "Sick", start: "2026-10-28", end: "2026-10-29", status: "approved", days: 2, applied: "2026-10-20" },
  { id: "l2", empId: "b", type: "Annual", start: "2026-11-02", end: "2026-11-04", status: "pending", days: 3, applied: "2026-10-22", reason: " Family event " },
  { id: "l3", empId: "h", type: "Annual", start: "2026-10-20", end: "2026-10-27", status: "approved", days: 6, applied: "2026-10-10" },
  { id: "l4", empId: "e", type: "Casual", start: "2026-10-30", end: "2026-10-30", status: "rejected", days: 1, applied: "2026-10-21" },
  { id: "l5", empId: "b", type: "Annual", start: "2026-12-01", end: "2026-12-02", status: "approved", days: 2, applied: "2026-10-01" },
  { id: "l6", empId: "e", type: "Casual", start: "2026-11-05", end: "2026-11-05", status: "pending", days: 1, applied: "2026-10-24" },
];

test("dates: isoOf and addDays work in local time across a month end", () => {
  assert.equal(isoOf(new Date(2026, 9, 5)), "2026-10-05");
  assert.equal(isoOf(addDays(new Date(2026, 9, 30), 3)), "2026-11-02");
});

test("presence: active people only, in / out / not yet from today's latest record, late counts as in", () => {
  const { people, counts } = presenceToday(E, attendance, now);
  assert.deepEqual(counts, { in: 2, out: 0, not: 1, total: 3 });
  assert.equal(people.find((p) => p.employee.id === "e").late, true);
  assert.equal(people.find((p) => p.employee.id === "b").state, "not");
  assert.equal(people.find((p) => p.employee.id === "h").checkIn, "08:52");
  assert.equal(people.some((p) => p.employee.id === "z"), false, "an inactive person is not counted");
});

test("presence: leave and absent today count as out; yesterday's record does not count for today", () => {
  const { counts } = presenceToday(E, [{ empId: "b", date: "2026-10-26", status: "on_leave" }, { empId: "h", date: "2026-10-25", status: "present" }], now);
  assert.equal(counts.out, 1);
  assert.equal(counts.in, 0);
  assert.equal(counts.not, 2);
});

test("presence: approved leave covering today puts someone with no record of their own out; a record, or pending leave, does not", () => {
  const covering = (empId, status) => ({ id: `x-${empId}`, empId, type: "Sick", start: "2026-10-25", end: "2026-10-27", status });
  const noRecords = presenceToday(E, [], now, [covering("b", "approved"), covering("e", "pending")]);
  assert.equal(noRecords.people.find((p) => p.employee.id === "b").state, "out");
  assert.equal(noRecords.people.find((p) => p.employee.id === "b").status, "leave");
  assert.equal(noRecords.people.find((p) => p.employee.id === "e").state, "not", "waiting for a decision is not away");
  const clockedIn = presenceToday(E, attendance, now, [covering("h", "approved")]);
  assert.equal(clockedIn.people.find((p) => p.employee.id === "h").state, "in", "someone who clocked in is in, whatever the leave says");
  const ended = presenceToday(E, [], now, [{ ...covering("b", "approved"), start: "2026-10-20", end: "2026-10-25" }]);
  assert.equal(ended.people.find((p) => p.employee.id === "b").state, "not", "leave that ended yesterday does not count");
});

test("payroll: a month with nothing processed yet has no change to report against last month", () => {
  const draftsOnly = [
    { empId: "h", month: "September", year: 2026, status: "processed", net: 80 },
    { empId: "h", month: "October", year: 2026, status: "draft", net: 100 },
  ];
  assert.equal(payrollSnapshot(draftsOnly, now).changePct, null);
});

test("week ahead: five working days from today, today from real clock-ins, later days from approved leave", () => {
  const presence = presenceToday(E, attendance, now);
  const week = weekAhead(E, leaves, presence, now);
  assert.deepEqual(week.map((d) => d.label), ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.deepEqual(week.map((d) => d.count), [2, 2, 2, 2, 3]);
  assert.equal(week[0].today, true);
  assert.equal(week[0].total, 3);
});

test("week ahead: a weekend start skips to Monday", () => {
  const saturday = new Date(2026, 9, 24, 9, 0);
  const week = weekAhead(E, [], null, saturday);
  assert.equal(week[0].label, "Mon");
  assert.equal(week[0].today, false);
  assert.equal(week[0].count, 3);
});

test("away calendar: 14 columns from today, weekends flagged, approved and waiting leave as bars clipped to the window", () => {
  const cal = awayCalendar(leaves, E, now);
  assert.equal(cal.columns.length, 14);
  assert.equal(cal.columns[0].iso, "2026-10-26");
  assert.equal(cal.columns[0].today, true);
  assert.deepEqual(cal.columns.filter((c) => c.weekend).map((c) => c.iso), ["2026-10-31", "2026-11-01", "2026-11-07", "2026-11-08"]);
  assert.deepEqual(cal.rows.map((r) => r.employee.id), ["h", "e", "b"], "ordered by whose leave starts first");
  const hanna = cal.rows[0].bars[0];
  assert.deepEqual([hanna.start, hanna.end, hanna.status], [0, 1, "approved"], "Hanna's leave began before today and is clipped to the window");
  const esha = cal.rows[1].bars;
  assert.deepEqual(esha.map((b) => [b.id, b.start, b.end, b.status]), [["l1", 2, 3, "approved"], ["l6", 10, 10, "pending"]]);
  assert.deepEqual(cal.rows[2].bars.map((b) => [b.start, b.end, b.status]), [[7, 9, "pending"]]);
});

test("away calendar: rejected leave, leave outside the window and unknown people are left out; nothing away says so", () => {
  const cal = awayCalendar([{ id: "x", empId: "nobody", type: "Annual", start: "2026-10-27", end: "2026-10-27", status: "approved" }, leaves[3], leaves[4]], E, now);
  assert.equal(cal.hasAny, false);
  assert.deepEqual(cal.rows, []);
});

test("decisions: waiting leave only, oldest first, with how long it has waited", () => {
  const items = decisionItems(leaves, E, now);
  assert.deepEqual(items.map((i) => i.key), ["leave:l2", "leave:l6"]);
  assert.equal(items[0].waitDays, 4);
  assert.equal(items[1].waitDays, 2);
  assert.equal(items[0].reason, "Family event");
  assert.equal(items[0].days, 3);
  assert.equal(items[0].employee.name, "Bilal Raza");
});

test("decisions: leave from someone outside the visible people is not offered", () => {
  assert.deepEqual(decisionItems([{ id: "q", empId: "ghost", status: "pending", start: "2026-11-01" }], E, now), []);
});

test("waiting label reads naturally", () => {
  assert.equal(waitingLabel(0), "Applied today");
  assert.equal(waitingLabel(1), "Waiting 1 day");
  assert.equal(waitingLabel(4), "Waiting 4 days");
});

test("awaiting rating: people with KPIs that have no valid rating, most first", () => {
  const kpis = [
    { empId: "b", rating: null }, { empId: "b", rating: 8 }, { empId: "e", rating: "" }, { empId: "h", rating: 9 }, { empId: "ghost", rating: null },
  ];
  const awaiting = awaitingRating(kpis, E);
  assert.deepEqual(awaiting.map((a) => [a.employee.id, a.unrated]), [["b", 1], ["e", 1]]);
});

const payroll = [
  { month: "October", year: 2026, net: 100, status: "processed" },
  { month: "October", year: 2026, net: 50, status: "draft" },
  { month: "September", year: 2026, net: 80, status: "processed" },
];

test("payroll: this month's processed total, drafts still open, change on last month", () => {
  const snap = payrollSnapshot(payroll, now);
  assert.deepEqual([snap.monthName, snap.year, snap.isCurrent, snap.total, snap.processed, snap.drafts, snap.stage, snap.changePct], ["October", 2026, true, 100, 1, 1, "review", 25]);
});

test("payroll: with no drafts the cycle is done; with no record this month it falls back to the latest month on record", () => {
  assert.equal(payrollSnapshot([payroll[0], payroll[2]], now).stage, "done");
  const november = new Date(2026, 10, 3);
  const snap = payrollSnapshot(payroll, november);
  assert.deepEqual([snap.monthName, snap.isCurrent], ["October", false]);
  assert.equal(payrollSnapshot([], now).stage, "none");
  assert.equal(payrollSnapshot(undefined, now).total, 0);
});

test("payroll need: drafts to finish, or a month not started, and nothing when it is all done", () => {
  assert.match(payrollNeed(payroll, now).title, /1 payroll record is still in draft/);
  assert.equal(payrollNeed([payroll[0], payroll[2]], now), null);
  assert.match(payrollNeed(payroll, new Date(2026, 10, 3)).title, /November payroll has not been started/);
  assert.match(payrollNeed([], now).note, /No payroll record exists yet/);
});

test("people: active headcount by department, and who joined in the last 30 days", () => {
  const snap = peopleSnapshot(E, now);
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.groups.map((g) => [g.name, g.count]), [["Engineering", 2], ["Administration", 1]]);
  assert.equal(Math.round(snap.groups[0].pct), 67);
  assert.deepEqual(snap.joiners.map((j) => [j.employee.id, j.daysAgo]), [["e", 14]]);
  assert.equal(snap.joinedRecently, 1);
  assert.equal(snap.latestJoiner.employee.id, "e");
});

test("performance: average, each person's rating strongest first, unrated people last", () => {
  const kpis = [{ empId: "b", rating: null }, { empId: "b", rating: 8 }, { empId: "e", rating: null }, { empId: "h", rating: 9 }];
  const snap = performanceSnapshot(kpis, E);
  assert.equal(snap.average, 8.5);
  assert.equal(snap.ratedCount, 2);
  assert.deepEqual(snap.people.map((p) => [p.employee.id, p.rating, p.unrated]), [["h", 9, 0], ["b", 8, 1], ["e", null, 1]]);
  assert.equal(snap.peopleRated, 2);
});

test("performance: no KPIs at all is an empty snapshot, not an error", () => {
  const snap = performanceSnapshot(undefined, E);
  assert.equal(snap.average, null);
  assert.deepEqual(snap.people, []);
});

test("greeting follows the hour", () => {
  assert.equal(greetingFor(new Date(2026, 9, 26, 7)), "Good morning");
  assert.equal(greetingFor(new Date(2026, 9, 26, 14)), "Good afternoon");
  assert.equal(greetingFor(new Date(2026, 9, 26, 20)), "Good evening");
});

test("dates read the way people say them", () => {
  assert.equal(formatDay("2026-11-02"), "2 Nov");
  assert.equal(formatRange("2026-11-02", "2026-11-04"), "2 to 4 Nov".replace("2 to 4 Nov", "2 Nov to 4 Nov"));
  assert.equal(formatRange("2026-11-02", "2026-11-02"), "2 Nov");
  assert.equal(formatRange("2026-11-02", undefined), "2 Nov");
  assert.equal(formatDay(""), "");
  assert.equal(longDate(now), "Monday, 26 October");
});
