/**
 * The sample company for the hosted demo, as plain data: who works there, what they have been doing, and what is
 * waiting for someone to decide. Everything is built relative to "today" so the dashboards always look current
 * (people in today, leave this week, payroll in review). Pure functions only -- seed-demo.js does the writing.
 */

import { randomInt } from "node:crypto";

// No 0/O, 1/l/I: a password read off a screen and typed must not be ambiguous.
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PASSWORD_GROUPS = 4;
const PASSWORD_GROUP_LENGTH = 4;

export function generatePassword() {
  const groups = [];
  for (let group = 0; group < PASSWORD_GROUPS; group += 1) {
    let text = "";
    for (let index = 0; index < PASSWORD_GROUP_LENGTH; index += 1) text += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    groups.push(text);
  }
  return groups.join("-");
}

/** "YYYY-MM-DD" for the calendar day it currently is in the given IANA zone. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const parseDay = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const addDays = (iso, days) => {
  const date = parseDay(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const isWeekend = (iso) => [0, 6].includes(parseDay(iso).getUTCDay());

export const DEMO_EMAIL_DOMAIN = "sigma-demo.example";

export const DEPARTMENTS = Object.freeze([
  { key: "eng", name: "Engineering", description: "Builds and maintains the product." },
  { key: "people", name: "People & Culture", description: "Hiring, leave, payroll and policy." },
  { key: "ops", name: "Operations", description: "Keeps the company running." },
]);

// `login` marks the five accounts whose credentials are handed over; the rest are colleagues who give the
// dashboards something to show. They get a random password nobody is told, so they cannot be signed in as.
// `joinedAgo` is days before today; `lead` is the key of the team lead in the same department.
export const PEOPLE = Object.freeze([
  { key: "admin", name: "Ayesha Khan", role: "admin", dept: "ops", position: "Administrator", basic: 260000, allowances: 40000, joinedAgo: 900, login: true },
  { key: "hr", name: "Bilal Ahmed", role: "hr", dept: "people", position: "HR Manager", basic: 190000, allowances: 25000, joinedAgo: 700, login: true },
  { key: "manager", name: "Sana Malik", role: "manager", dept: "eng", position: "Engineering Manager", basic: 230000, allowances: 30000, joinedAgo: 800, login: true },
  { key: "tl", name: "Hamza Raza", role: "tl", dept: "eng", position: "Team Lead", basic: 170000, allowances: 20000, joinedAgo: 600, login: true },
  { key: "employee", name: "Zainab Ali", role: "employee", dept: "eng", position: "Software Engineer", basic: 120000, allowances: 15000, joinedAgo: 400, lead: "tl", login: true },
  { key: "omar", name: "Omar Sheikh", role: "employee", dept: "eng", position: "QA Engineer", basic: 95000, allowances: 10000, joinedAgo: 300, lead: "tl" },
  { key: "mehwish", name: "Mehwish Noor", role: "employee", dept: "eng", position: "Product Designer", basic: 110000, allowances: 12000, joinedAgo: 250, lead: "tl" },
  { key: "usman", name: "Usman Tariq", role: "employee", dept: "eng", position: "Backend Engineer", basic: 130000, allowances: 15000, joinedAgo: 45, lead: "tl" },
  { key: "hira", name: "Hira Baig", role: "employee", dept: "people", position: "Recruiter", basic: 85000, allowances: 8000, joinedAgo: 20 },
  { key: "danish", name: "Danish Iqbal", role: "employee", dept: "ops", position: "Operations Analyst", basic: 90000, allowances: 9000, joinedAgo: 500 },
]);

export const emailFor = (key) => `${key}@${DEMO_EMAIL_DOMAIN}`;

// The manager of each department, shown on the departments page.
export const DEPARTMENT_MANAGERS = Object.freeze({ eng: "manager", people: "hr", ops: "admin" });

export const PROJECTS = Object.freeze([
  { key: "web", title: "Website Redesign", dept: "eng", lead: "tl", status: "active", startAgo: 60, dueIn: 30,
    description: "New marketing site and sign-up flow.", assigned: ["employee", "omar", "mehwish"] },
  { key: "mobile", title: "Mobile App v2", dept: "eng", lead: "tl", status: "active", startAgo: 30, dueIn: 75,
    description: "Second release of the mobile app.", assigned: ["employee", "usman"] },
  { key: "hiring", title: "Q4 Hiring Drive", dept: "people", lead: null, status: "active", startAgo: 14, dueIn: 60,
    description: "Fill six open roles before year end.", assigned: ["hira"] },
]);

// rating is set afterwards by an approver; null means "waiting to be rated".
export const KPIS = Object.freeze([
  { project: "web", person: "employee", title: "Pages shipped", target: 12, current: 9, weight: 40, period: "Q4", rating: 9 },
  { project: "web", person: "employee", title: "Accessibility issues closed", target: 30, current: 12, weight: 30, period: "Q4", rating: null },
  { project: "mobile", person: "employee", title: "Screens migrated", target: 20, current: 6, weight: 30, period: "Q4", rating: null },
  { project: "web", person: "omar", title: "Test cases automated", target: 80, current: 64, weight: 50, period: "Q4", rating: 8 },
  { project: "web", person: "mehwish", title: "Design reviews completed", target: 10, current: 4, weight: 50, period: "Q4", rating: null },
  { project: "mobile", person: "usman", title: "API endpoints delivered", target: 15, current: 5, weight: 60, period: "Q4", rating: null },
  { project: "hiring", person: "hira", title: "Candidates interviewed", target: 40, current: 31, weight: 100, period: "Q4", rating: 7 },
]);

// Leave requests, each applied for by the person themselves; `decision` is applied afterwards by an approver.
// `from`/`to` are days relative to today. Every person's requests are kept apart so none overlap.
export const LEAVES = Object.freeze([
  { person: "omar", type: "Sick", from: -1, to: 1, reason: "Down with the flu", decision: "approved" },
  { person: "hira", type: "Annual", from: -40, to: -38, reason: "Family wedding", decision: "approved" },
  { person: "mehwish", type: "Sick", from: -9, to: -8, reason: "Doctor's appointment", decision: "approved" },
  { person: "employee", type: "Casual", from: -20, to: -20, reason: "Personal errand", decision: "rejected" },
  { person: "employee", type: "Annual", from: 12, to: 14, reason: "Trip to the north", decision: null },
  { person: "usman", type: "Annual", from: 3, to: 5, reason: "Moving house", decision: null },
  { person: "tl", type: "Casual", from: 20, to: 21, reason: "Visa appointment", decision: null },
  { person: "manager", type: "Annual", from: 30, to: 34, reason: "Family holiday", decision: null },
  { person: "danish", type: "Annual", from: 6, to: 7, reason: "Long weekend", decision: null },
]);

/** Attendance for the last `weekdays` working days before today, and some of today. */
export function buildAttendance(today, weekdays = 14) {
  const records = [];
  const staff = PEOPLE.map((person) => person.key);

  // A small, deterministic wobble so the history is not one flat line of "present".
  const pattern = (personIndex, dayIndex) => (personIndex * 7 + dayIndex * 3) % 11;
  const clock = (hour, minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  // Days someone was on approved leave are recorded as leave, not as a day they came in.
  const onLeave = new Set();
  for (const leave of LEAVES.filter((entry) => entry.decision === "approved")) {
    for (let offset = leave.from; offset <= leave.to; offset += 1) onLeave.add(`${leave.person}|${addDays(today, offset)}`);
  }

  let day = today;
  let dayIndex = 0;
  while (dayIndex < weekdays) {
    day = addDays(day, -1);
    if (isWeekend(day)) continue;
    staff.forEach((key, personIndex) => {
      const wobble = pattern(personIndex, dayIndex);
      if (onLeave.has(`${key}|${day}`)) records.push({ person: key, date: day, status: "leave" });
      else if (wobble === 0 && key !== "admin") records.push({ person: key, date: day, status: "absent" });
      else if (wobble === 1 || wobble === 2) records.push({ person: key, date: day, status: "late", check_in: clock(9, 25 + wobble * 6), check_out: clock(17, 30 + wobble) });
      else records.push({ person: key, date: day, status: "present", check_in: clock(8, 50 + (wobble % 8)), check_out: clock(17, 5 + wobble) });
    });
    dayIndex += 1;
  }

  // Today: most are in, one is late, one is away on leave (see LEAVES), two have not clocked in yet.
  if (!isWeekend(today)) {
    const clockedIn = { admin: [8, 52], hr: [9, 1], manager: [8, 47], tl: [9, 3], employee: [8, 58], danish: [9, 10] };
    for (const [key, [hour, minute]] of Object.entries(clockedIn)) records.push({ person: key, date: today, status: "present", check_in: clock(hour, minute) });
    records.push({ person: "mehwish", date: today, status: "late", check_in: clock(9, 48) });
    // The leave request for Omar covers today; no attendance row, so he shows as away. usman and hira are not in yet.
  }
  return records;
}

/** Payroll for the three months before this one (processed) and this month (partly processed, the rest still drafts). */
export function buildPayroll(today) {
  const [year, month] = today.split("-").map(Number);
  const periods = [];
  for (let back = 3; back >= 1; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    periods.push({ year: Math.floor(index / 12), month: (index % 12) + 1, status: "processed" });
  }
  periods.push({ year, month, status: "partial" });
  const rows = [];
  for (const period of periods) {
    for (const [index, person] of PEOPLE.entries()) {
      // The newest hires were not here for the oldest months.
      const joinedIso = addDays(today, -person.joinedAgo);
      const periodEnd = `${period.year}-${String(period.month).padStart(2, "0")}-28`;
      if (joinedIso > periodEnd) continue;
      rows.push({
        person: person.key,
        period_year: period.year,
        period_month: period.month,
        bonus: period.status !== "partial" && person.key === "omar" ? 5000 : 0,
        deductions: 0,
        // This month: the first six are processed, the last four are left for someone to review.
        status: period.status === "partial" ? (index < 6 ? "processed" : "draft") : period.status,
      });
    }
  }
  return rows;
}

export function buildPlan(today) {
  return {
    today,
    departments: DEPARTMENTS,
    people: PEOPLE.map((person) => ({ ...person, email: emailFor(person.key), joined_on: addDays(today, -person.joinedAgo) })),
    projects: PROJECTS.map((project) => ({ ...project, start_date: addDays(today, -project.startAgo), due_date: addDays(today, project.dueIn) })),
    kpis: KPIS,
    leaves: LEAVES.map((leave) => ({ ...leave, start_date: addDays(today, leave.from), end_date: addDays(today, leave.to) })),
    attendance: buildAttendance(today),
    payroll: buildPayroll(today),
    departmentManagers: DEPARTMENT_MANAGERS,
  };
}
