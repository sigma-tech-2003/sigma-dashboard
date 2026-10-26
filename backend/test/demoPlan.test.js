import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, buildPlan, generatePassword, isWeekend, PEOPLE, todayIn } from "../scripts/demoPlan.js";

// A Monday and a Sunday, so the weekday-only rules are exercised either way.
for (const today of ["2026-10-26", "2026-10-25", "2026-01-02"]) {
  const plan = buildPlan(today);

  test(`${today}: there is exactly one login per role, and every role is covered`, () => {
    const logins = plan.people.filter((person) => person.login);
    assert.deepEqual(logins.map((person) => person.role).sort(), ["admin", "employee", "hr", "manager", "tl"]);
    assert.equal(new Set(plan.people.map((person) => person.email)).size, plan.people.length);
  });

  test(`${today}: a team lead is in the same department as everyone they lead`, () => {
    const byKey = Object.fromEntries(plan.people.map((person) => [person.key, person]));
    for (const person of plan.people.filter((entry) => entry.lead)) {
      assert.equal(byKey[person.lead].dept, person.dept, person.key);
      assert.equal(byKey[person.lead].role, "tl");
      assert.ok(plan.people.findIndex((entry) => entry.key === person.lead) < plan.people.indexOf(person), "the lead is written first");
    }
  });

  test(`${today}: nobody joins in the future, and nothing is dated after today`, () => {
    assert.ok(plan.people.every((person) => person.joined_on <= today));
    assert.ok(plan.attendance.every((record) => record.date <= today));
    assert.ok(plan.payroll.every((row) => row.period_year * 100 + row.period_month <= Number(today.slice(0, 4)) * 100 + Number(today.slice(5, 7))));
  });

  test(`${today}: attendance has no weekends, no duplicate day per person, and sensible times`, () => {
    assert.ok(plan.attendance.every((record) => !isWeekend(record.date)));
    const seen = new Set(plan.attendance.map((record) => `${record.person}|${record.date}`));
    assert.equal(seen.size, plan.attendance.length);
    for (const record of plan.attendance) {
      if (record.status === "absent") assert.equal(record.check_in, undefined);
      if (record.check_in && record.check_out) assert.ok(record.check_out > record.check_in);
      if (record.check_in) assert.match(record.check_in, /^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });

  test(`${today}: nobody who is away today has an attendance row for it`, () => {
    const away = plan.leaves.filter((leave) => leave.decision === "approved" && leave.start_date <= today && leave.end_date >= today);
    for (const leave of away) assert.ok(!plan.attendance.some((record) => record.person === leave.person && record.date === today));
  });

  test(`${today}: a day of approved leave is recorded as leave, never as a day the person came in`, () => {
    for (const leave of plan.leaves.filter((entry) => entry.decision === "approved")) {
      for (const record of plan.attendance.filter((entry) => entry.person === leave.person && entry.date >= leave.start_date && entry.date <= leave.end_date)) {
        assert.equal(record.status, "leave", `${leave.person} ${record.date}`);
        assert.equal(record.check_in, undefined);
      }
    }
  });

  test(`${today}: leave dates are ordered and one person's requests never overlap`, () => {
    for (const leave of plan.leaves) assert.ok(leave.end_date >= leave.start_date);
    for (const person of PEOPLE) {
      const mine = plan.leaves.filter((leave) => leave.person === person.key).sort((a, b) => a.start_date.localeCompare(b.start_date));
      for (let index = 1; index < mine.length; index += 1) assert.ok(mine[index].start_date > mine[index - 1].end_date, person.key);
    }
  });

  test(`${today}: the demo shows something to decide, and every state of leave`, () => {
    const states = new Set(plan.leaves.map((leave) => leave.decision ?? "pending"));
    assert.deepEqual([...states].sort(), ["approved", "pending", "rejected"]);
    assert.ok(plan.leaves.filter((leave) => !leave.decision && leave.start_date > today).length >= 3);
  });

  test(`${today}: projects, KPIs and payroll refer only to people and projects that exist`, () => {
    const keys = new Set(plan.people.map((person) => person.key));
    const projects = new Set(plan.projects.map((project) => project.key));
    for (const project of plan.projects) {
      assert.ok(project.due_date >= project.start_date);
      assert.ok(project.assigned.every((key) => keys.has(key)));
    }
    for (const kpi of plan.kpis) {
      assert.ok(projects.has(kpi.project));
      assert.ok(plan.projects.find((project) => project.key === kpi.project).assigned.includes(kpi.person), "a KPI needs an assigned person");
      assert.ok(kpi.weight >= 1 && kpi.weight <= 100 && kpi.target > 0 && kpi.current >= 0);
    }
    assert.ok(plan.payroll.every((row) => keys.has(row.person)));
    assert.ok(plan.kpis.some((kpi) => kpi.rating === null) && plan.kpis.some((kpi) => kpi.rating !== null));
  });

  test(`${today}: payroll is processed for past months, and this month is part processed with drafts left to review`, () => {
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const current = plan.payroll.filter((row) => row.period_year === year && row.period_month === month);
    assert.ok(current.some((row) => row.status === "draft") && current.some((row) => row.status === "processed"));
    assert.ok(plan.payroll.filter((row) => !(row.period_year === year && row.period_month === month)).every((row) => row.status === "processed"));
    assert.equal(new Set(plan.payroll.map((row) => `${row.person}|${row.period_year}|${row.period_month}`)).size, plan.payroll.length);
  });
}

test("dates: addDays crosses month and year ends, and todayIn reads the calendar day in the given zone", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  // 21:00 UTC on the 25th is already the 26th in Karachi (UTC+5).
  assert.equal(todayIn("Asia/Karachi", new Date("2026-10-25T21:00:00Z")), "2026-10-26");
  assert.equal(todayIn("UTC", new Date("2026-10-25T21:00:00Z")), "2026-10-25");
});

test("generated passwords are long, unambiguous to read, and different every time", () => {
  const passwords = Array.from({ length: 200 }, () => generatePassword());
  assert.equal(new Set(passwords).size, passwords.length);
  for (const password of passwords) {
    assert.match(password, /^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/);
    assert.doesNotMatch(password, /[0O1lI]/);
  }
});
