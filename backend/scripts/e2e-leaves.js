/**
 * End-to-end check of the Phase 9 leave write endpoints and the leave-balance endpoint against a
 * REAL PostgreSQL database: the real container, repositories, services and routes (over HTTP), with
 * only authentication stubbed. The unit tests run against fakes and cannot see SQL, locks,
 * constraint names, the replaced employee_leave_usage view or pg's date and integer types; this can.
 *
 *   node scripts/e2e-leaves.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL,
 * AUTH_TOKEN_SECRET, COMPANY_TIMEZONE), and migration 010 already applied (`npm run db:migrate`).
 *
 * It writes: departments, users, employees and leaves, all tagged `p9e2e-<random>`. Everything it
 * creates is deleted again in a `finally`, found by that tag rather than by remembered ids, so a run
 * that dies half-way through seeding still cleans up. It never touches a row it did not create.
 * Exits non-zero if any check fails.
 *
 * Among other things it proves, against the real database: that migration 010's view produces the
 * right per-calendar-month numbers for leaves that span month, year and leap-day boundaries; that the
 * per-employee FOR NO KEY UPDATE lock really serialises concurrent applies (a burst, and a holder
 * transaction) without blocking other tables' foreign-key checks; that the self-approval ban is the
 * DATABASE's; and that the guarded UPDATEs make a decided leave immutable under a real race.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { getCompanyTimezone } from "../src/config/env.js";
import { getContainer, resetContainer } from "../src/container.js";
import { closePool, getPool } from "../src/db/pool.js";
import { splitDaysByMonth } from "../src/services/leaveEntitlements.js";
import { todayInTimeZone } from "../src/utils/companyDate.js";

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
  }
  return flags;
}

/**
 * Deletes everything this run created, located by TAG. Leaves go first: employee_id and
 * decided_by_employee_id are ON DELETE RESTRICT, so an employee with a leave cannot be deleted.
 */
async function cleanup(pool, tag) {
  const employees = "(SELECT id FROM employees WHERE employee_number LIKE $1)";
  const like = `${tag}-%`;
  await pool.query(
    `DELETE FROM leaves
     WHERE employee_id IN ${employees}
        OR decided_by_employee_id IN ${employees}
        OR deleted_by_employee_id IN ${employees}`,
    [like],
  );
  await pool.query("UPDATE employees SET team_lead_id = NULL WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM employees WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}-%@example.invalid`]);
  await pool.query("DELETE FROM departments WHERE name LIKE $1", [like]);
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function run(pool, tag) {
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.info(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  };
  const check = (name, condition, detail) => record(name, Boolean(condition), detail);
  const showing = (value) => JSON.stringify(value);
  const timeZone = getCompanyTimezone();
  const today = todayInTimeZone(new Date(), timeZone);

  console.info(`tag: ${tag}   timezone: ${timeZone}   today there: ${today}\n`);

  // -------------------------------------------------------------------------
  // Seed
  // -------------------------------------------------------------------------
  const { rows: [company] } = await pool.query("SELECT id FROM companies LIMIT 1");
  if (!company) throw new Error("No companies row exists; bootstrap the database first.");

  // Every seeded person is registered as a stub principal under their label, so a call can say
  // `call("e1", ...)`. Authentication is the only thing stubbed.
  const principals = {};
  const department = async (suffix) => {
    const { rows: [row] } = await pool.query(
      "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id", [company.id, `${tag}-${suffix}`]);
    return row.id;
  };
  const person = async (label, role, departmentId, { teamLeadId = null, joinedOn = "2024-01-01" } = {}) => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (company_id, email, role) VALUES ($1, $2, $3) RETURNING id",
      [company.id, `${tag}-${label}@example.invalid`, role]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, team_lead_id, employee_number, full_name, position_title,
                              joined_on, employment_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'E2E', $7, 'active') RETURNING id`,
      [user.id, company.id, departmentId, teamLeadId, `${tag}-${label}`, `${tag} ${label}`, joinedOn]);
    const made = { userId: user.id, employeeId: employee.id, role, departmentId };
    principals[label] = made;
    return made;
  };

  const deptA = await department("A");
  const deptB = await department("B");
  const admin = await person("admin", "admin", deptA);
  const hr = await person("hr", "hr", deptA);
  const manager = await person("manager", "manager", deptA);
  const mgrB = await person("mgrB", "manager", deptB);
  const tl1 = await person("tl1", "tl", deptA);
  const tl2 = await person("tl2", "tl", deptA);
  const tlB = await person("tlB", "tl", deptB);
  const e1 = await person("e1", "employee", deptA, { teamLeadId: tl1.employeeId });
  const e2 = await person("e2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const e3 = await person("e3", "employee", deptA, { teamLeadId: tl2.employeeId });
  const eB = await person("eB", "employee", deptB, { teamLeadId: tlB.employeeId });
  // One employee per scenario, so no scenario's usage can leak into another's numbers.
  const eView = await person("eView", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eSpan = await person("eSpan", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eDec = await person("eDec", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eDec2 = await person("eDec2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eNov = await person("eNov", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eSN = await person("eSN", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eSN2 = await person("eSN2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eSN3 = await person("eSN3", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eNew = await person("eNew", "employee", deptA, { teamLeadId: tl1.employeeId, joinedOn: "2026-06-15" });
  const eRej = await person("eRej", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eProm = await person("eProm", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace1 = await person("eRace1", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace2 = await person("eRace2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace3 = await person("eRace3", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace4 = await person("eRace4", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace5 = await person("eRace5", "employee", deptA, { teamLeadId: tl1.employeeId });
  principals.noEmployee = { userId: randomUUID(), employeeId: null, role: "admin", departmentId: null };

  // -------------------------------------------------------------------------
  // Migration 010's schema, against what Postgres actually generated
  // -------------------------------------------------------------------------
  const { rows: foreignKeys } = await pool.query(
    `SELECT c.conname, a.attname AS column_name, c.confdeltype
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'leaves'::regclass AND c.contype = 'f'`);
  console.info(`leaves foreign keys as generated: ${foreignKeys.map((fk) => `${fk.column_name} -> ${fk.conname} (on delete ${fk.confdeltype})`).join("; ")}`);
  const fkFor = (column) => foreignKeys.find((fk) => fk.column_name === column);
  check("leaves.employee_id FK is named leaves_employee_id_fkey (the name the translator assumes)",
    fkFor("employee_id")?.conname === "leaves_employee_id_fkey", `actual: ${fkFor("employee_id")?.conname}`);
  check("leaves.decided_by_employee_id FK is leaves_decided_by_employee_id_fkey",
    fkFor("decided_by_employee_id")?.conname === "leaves_decided_by_employee_id_fkey", `actual: ${fkFor("decided_by_employee_id")?.conname}`);
  check("leaves.deleted_by_employee_id FK is leaves_deleted_by_employee_id_fkey, ON DELETE SET NULL ('n')",
    fkFor("deleted_by_employee_id")?.conname === "leaves_deleted_by_employee_id_fkey" && fkFor("deleted_by_employee_id")?.confdeltype === "n",
    `actual: ${showing(fkFor("deleted_by_employee_id"))}`);

  const { rows: constraints } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'leaves'::regclass");
  const { rows: indexes } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'leaves'");
  const names = new Set([...constraints.map((row) => row.conname), ...indexes.map((row) => row.indexname)]);
  for (const name of [
    "leaves_no_self_approval", "leaves_dates_ordered", "leaves_decision_consistent", "leaves_reason_not_blank",
    "leaves_deleted_by_requires_deleted_at", "leaves_deleted_by_index",
  ]) {
    check(`constraint/index exists: ${name}`, names.has(name), `present: ${[...names].join(", ")}`);
  }

  const { rows: viewColumns } = await pool.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_name = 'employee_leave_usage' ORDER BY ordinal_position`);
  console.info(`employee_leave_usage columns as generated: ${viewColumns.map((c) => `${c.column_name}:${c.udt_name}`).join(", ")}`);
  check("the replaced view has exactly employee_id, type, usage_year, usage_month, days_approved, days_pending, in that order",
    showing(viewColumns.map((c) => c.column_name)) === showing(["employee_id", "type", "usage_year", "usage_month", "days_approved", "days_pending"]),
    showing(viewColumns.map((c) => c.column_name)));
  check("...typed uuid, leave_type, then four integers (int4, so pg hands back JS numbers, not strings)",
    showing(viewColumns.map((c) => c.udt_name)) === showing(["uuid", "leave_type", "int4", "int4", "int4", "int4"]), showing(viewColumns.map((c) => c.udt_name)));
  try {
    await pool.query("SELECT leave_year FROM employee_leave_usage LIMIT 1");
    record("001's view columns are gone (leave_year)", false, "the query succeeded");
  } catch (error) {
    check("001's view columns are gone (leave_year -> 42703 undefined_column)", error.code === "42703", `${error.code}`);
  }

  // -------------------------------------------------------------------------
  // HTTP: real container, repositories, services, routes; authentication stubbed
  // -------------------------------------------------------------------------
  resetContainer();
  const server = createServer(createApp({ verifyAccessToken: async (token) => principals[token] }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const call = async (as, method, pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
        method,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const container = getContainer();
    const leaveRow = async (id) => (await pool.query("SELECT * FROM leaves WHERE id = $1", [id])).rows[0];
    const rawError = async (sql, params) => {
      try { await pool.query(sql, params); return null; } catch (error) { return error; }
    };
    const apply = (as, type, start, end = start, extra = {}) =>
      call(as, "POST", "/leaves", { type, start_date: start, end_date: end, reason: "e2e", ...extra });
    const errorOf = (response) => `${response.status} ${response.body?.error?.code}`;
    const viewRows = async (employeeId) => (await pool.query(
      "SELECT * FROM employee_leave_usage WHERE employee_id = $1 ORDER BY type, usage_year, usage_month", [employeeId])).rows;
    const asKeys = (rows) => rows.map((row) => `${row.type}|${row.usage_year}|${row.usage_month}|${row.days_approved}|${row.days_pending}`);
    const balance = async (as, query = "") => (await call(as, "GET", `/leave-balances${query}`));
    const rawLeave = async (employeeId, type, start, end, status = "pending", { deleted = false } = {}) => {
      const { rows: [row] } = await pool.query(
        `INSERT INTO leaves (employee_id, type, start_date, end_date, reason, status, applied_on,
                             decided_by_employee_id, decided_at, deleted_at, deleted_by_employee_id)
         VALUES ($1, $2, $3, $4, 'e2e raw', $5::leave_status, '2026-01-01',
                 CASE WHEN $5::text = 'pending' THEN NULL ELSE $6::uuid END,
                 CASE WHEN $5::text = 'pending' THEN NULL ELSE now() END,
                 CASE WHEN $7::boolean THEN now() END,
                 CASE WHEN $7::boolean THEN $6::uuid END)
         RETURNING id`,
        [employeeId, type, start, end, status, admin.employeeId, deleted]);
      return row.id;
    };

    // ======================================================================
    // THE REPLACED VIEW, against real Postgres: per-month numbers for leaves that span boundaries
    // ======================================================================
    // Raw inserts (bypassing the API, so the view is judged on its own). Every expected row below is
    // worked out by hand from the calendar, not by the code under test.
    await rawLeave(eView.employeeId, "Annual", "2026-01-30", "2026-02-02", "approved");   // Jan 2, Feb 2
    await rawLeave(eView.employeeId, "Annual", "2026-02-26", "2026-03-01", "pending");    // Feb 3 (26,27,28), Mar 1
    await rawLeave(eView.employeeId, "Annual", "2026-01-05", "2026-01-05", "approved");   // Jan +1 (a second leave in the same month)
    await rawLeave(eView.employeeId, "Casual", "2026-12-30", "2027-01-02", "approved");   // Dec 2 | Jan 2 -- a year boundary
    await rawLeave(eView.employeeId, "Sick", "2028-02-28", "2028-03-01", "approved");     // LEAP year: Feb 28+29 = 2 | Mar 1
    await rawLeave(eView.employeeId, "Sick", "2027-03-10", "2027-03-10", "pending");      // one day
    await rawLeave(eView.employeeId, "Maternity", "2026-08-01", "2026-10-31", "approved"); // Aug 31, Sep 30, Oct 31
    await rawLeave(eView.employeeId, "Annual", "2026-04-29", "2026-06-02", "approved");   // Apr 2, May 31, Jun 2 -- spans THREE boundaries
    await rawLeave(eView.employeeId, "Annual", "2026-09-01", "2026-09-01", "pending");    // Sep: pending 1 ...
    await rawLeave(eView.employeeId, "Annual", "2026-09-10", "2026-09-11", "approved");   // ... and approved 2, one grouped row
    await rawLeave(eView.employeeId, "Emergency", "2026-05-01", "2026-05-10", "rejected"); // rejected: never counts
    await rawLeave(eView.employeeId, "Annual", "2026-07-01", "2026-07-05", "approved", { deleted: true }); // soft-deleted: never counts
    await rawLeave(eView.employeeId, "Annual", "2026-02-10", "2026-02-11", "pending", { deleted: true });  // would corrupt Feb if it counted

    const expectedView = [
      "Annual|2026|1|3|0",   // 30,31 Jan (leave 1) + 5 Jan
      "Annual|2026|2|2|3",   // 1,2 Feb approved (leave 1) + 26,27,28 Feb pending
      "Annual|2026|3|0|1",   // 1 Mar pending
      "Annual|2026|4|2|0",   // 29,30 Apr
      "Annual|2026|5|31|0",  // all of May
      "Annual|2026|6|2|0",   // 1,2 Jun
      "Annual|2026|9|2|1",   // approved 10,11 and pending 1, grouped into ONE row
      "Casual|2026|12|2|0",
      "Casual|2027|1|2|0",
      "Maternity|2026|10|31|0",
      "Maternity|2026|8|31|0",
      "Maternity|2026|9|30|0",
      "Sick|2027|3|0|1",
      "Sick|2028|2|2|0",     // 2028 is a leap year: 28 and 29 February
      "Sick|2028|3|1|0",
    ];
    const actualRows = await viewRows(eView.employeeId);
    const actualKeys = asKeys(actualRows);
    if (!sameSet(actualKeys, expectedView)) {
      console.info(`view expected: ${showing([...expectedView].sort())}\nview actual:   ${showing([...actualKeys].sort())}`);
    }
    check("VIEW: the per-employee, per-type, per-month rows are exactly the hand-computed set", sameSet(actualKeys, expectedView),
      `missing: ${showing(expectedView.filter((key) => !actualKeys.includes(key)))} unexpected: ${showing(actualKeys.filter((key) => !expectedView.includes(key)))}`);
    const cell = (type, year, month) => actualRows.find((row) => row.type === type && row.usage_year === year && row.usage_month === month);
    check("VIEW: 30 Jan - 2 Feb (approved) is 2 days in JANUARY and 2 in FEBRUARY, not 4 in January (the boundary the 001 view got wrong)",
      cell("Annual", 2026, 1)?.days_approved === 3 && cell("Annual", 2026, 2)?.days_approved === 2, showing([cell("Annual", 2026, 1), cell("Annual", 2026, 2)]));
    check("VIEW: 26 Feb - 1 Mar (pending) is 3 days in February and 1 in March, with approved and pending in separate columns",
      cell("Annual", 2026, 2)?.days_pending === 3 && cell("Annual", 2026, 3)?.days_pending === 1 && cell("Annual", 2026, 3)?.days_approved === 0, showing(cell("Annual", 2026, 3)));
    check("VIEW: 30 Dec - 2 Jan crosses a YEAR: usage_year 2026 month 12 and usage_year 2027 month 1",
      cell("Casual", 2026, 12)?.days_approved === 2 && cell("Casual", 2027, 1)?.days_approved === 2, showing([cell("Casual", 2026, 12), cell("Casual", 2027, 1)]));
    check("VIEW: 28 Feb - 1 Mar 2028 knows the LEAP day: 2 days in February, 1 in March",
      cell("Sick", 2028, 2)?.days_approved === 2 && cell("Sick", 2028, 3)?.days_approved === 1, showing([cell("Sick", 2028, 2), cell("Sick", 2028, 3)]));
    check("VIEW: a leave spanning three months (29 Apr - 2 Jun) is 2 + 31 + 2",
      cell("Annual", 2026, 4)?.days_approved === 2 && cell("Annual", 2026, 5)?.days_approved === 31 && cell("Annual", 2026, 6)?.days_approved === 2, "");
    check("VIEW: rejected leaves never count (no Emergency row)", !actualRows.some((row) => row.type === "Emergency"), "");
    check("VIEW: soft-deleted leaves never count (no July row; February holds only the live numbers)",
      !actualRows.some((row) => row.usage_month === 7) && cell("Annual", 2026, 2)?.days_pending === 3, "");
    check("VIEW: Maternity IS in the view (it is a usage fact); only the code's pool map exempts it",
      cell("Maternity", 2026, 8)?.days_approved === 31, "");
    check("VIEW: every number is a JS number, not a string (int4, not bigint)",
      actualRows.every((row) => ["usage_year", "usage_month", "days_approved", "days_pending"].every((column) => typeof row[column] === "number")), showing(actualRows[0]));

    const { rows: [{ leaves_days: leavesDays }] } = await pool.query(
      `SELECT COALESCE(sum(days), 0)::int AS leaves_days FROM leaves
       WHERE employee_id = $1 AND status IN ('approved', 'pending') AND deleted_at IS NULL`, [eView.employeeId]);
    const viewDays = actualRows.reduce((sum, row) => sum + row.days_approved + row.days_pending, 0);
    check(`VIEW: the days it splits add back up to leaves.days (the generated column): ${viewDays} = ${leavesDays}`, viewDays === leavesDays, `${viewDays} vs ${leavesDays}`);

    // The JS split the apply path uses must agree with what the view computes, leave by leave.
    const { rows: liveLeaves } = await pool.query(
      `SELECT type, status, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM leaves
       WHERE employee_id = $1 AND status IN ('approved', 'pending') AND deleted_at IS NULL`, [eView.employeeId]);
    const jsTally = new Map();
    for (const leave of liveLeaves) {
      for (const part of splitDaysByMonth(leave.s, leave.e)) {
        const key = `${leave.type}|${part.year}|${part.month}`;
        const entry = jsTally.get(key) ?? { approved: 0, pending: 0 };
        entry[leave.status] += part.days;
        jsTally.set(key, entry);
      }
    }
    check("VIEW: it agrees, row for row, with splitDaysByMonth (the code that checks the allowance)",
      sameSet([...jsTally].map(([key, value]) => `${key}|${value.approved}|${value.pending}`), actualKeys), "");

    // Replaced, not additive: other employees are untouched by eView's leaves.
    check("VIEW: another employee has no rows from eView's leaves", (await viewRows(e3.employeeId)).length === 0, "");

    // ======================================================================
    // Serialization, defaults, and the controls that show why the fixes matter
    // ======================================================================
    const first = await apply("e1", "Annual", "2026-03-10", "2026-03-11", { reason: "  Family wedding  " });
    check("POST /leaves as the employee -> 201", first.status === 201, showing(first));
    const l1 = first.body?.data;
    check("start_date, end_date and applied_on come back as plain YYYY-MM-DD strings; days is a number",
      l1?.start_date === "2026-03-10" && l1?.end_date === "2026-03-11" && l1?.applied_on === today && l1?.days === 2, showing(l1));
    check("status is pending, undecided, and the reason is trimmed",
      l1?.status === "pending" && l1?.decided_by_employee_id === null && l1?.decided_at === null && l1?.reason === "Family wedding", showing(l1));
    const l1Row = await leaveRow(l1?.id);
    check("the database row agrees: the applicant is the principal, decision_recorded true, nothing deleted",
      l1Row?.employee_id === e1.employeeId && l1Row.decision_recorded === true && l1Row.deleted_at === null && l1Row.deleted_by_employee_id === null && l1Row.days === 2, showing(l1Row));
    check("control: a raw `date` column really does come back from pg as a JS Date (local-midnight), so the to_char fix matters",
      l1Row?.start_date instanceof Date && l1Row?.applied_on instanceof Date, showing(l1Row));
    check("GET /leaves/:id is not shadowed by the write router, and agrees on the dates",
      (await call("e1", "GET", `/leaves/${l1?.id}`)).body?.data?.start_date === "2026-03-10", "");
    check("GET /leaves list returns date strings too", (await call("admin", "GET", "/leaves")).body?.data?.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.start_date)), "");

    // ======================================================================
    // Apply: every role, for themselves
    // ======================================================================
    const ownLeaves = {};
    for (const label of ["admin", "hr", "manager", "tl1"]) {
      const response = await apply(label, "Annual", "2026-03-10", "2026-03-11");
      check(`POST /leaves as ${label} -> 201, for themselves`, response.status === 201
        && (await leaveRow(response.body?.data?.id))?.employee_id === principals[label].employeeId, showing(response));
      ownLeaves[label] = response.body?.data;
    }
    check("an account with no employee record cannot apply, decide or delete -> 403 role_not_allowed",
      errorOf(await apply("noEmployee", "Annual", "2026-03-10")) === "403 role_not_allowed"
      && errorOf(await call("noEmployee", "PATCH", `/leaves/${l1?.id}`, { status: "approved" })) === "403 role_not_allowed"
      && errorOf(await call("noEmployee", "DELETE", `/leaves/${l1?.id}`)) === "403 role_not_allowed"
      && errorOf(await balance("noEmployee")) === "403 role_not_allowed", "");

    // ---- strict schema, with the database never reached ----
    const liveCount = async () => (await pool.query(
      "SELECT count(*)::int AS n FROM leaves WHERE employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)", [`${tag}-%`])).rows[0].n;
    const beforeBad = await liveCount();
    const badBodies = [
      { type: "Annual", start_date: "2026-05-04", end_date: "2026-05-04", reason: "x", employee_id: e2.employeeId },
      { type: "Annual", start_date: "2026-05-04", end_date: "2026-05-04", reason: "x", status: "approved" },
      { type: "Annual", start_date: "2026-05-04", end_date: "2026-05-04", reason: "x", days: 9 },
      { type: "Sabbatical", start_date: "2026-05-04", end_date: "2026-05-04", reason: "x" },
      { type: "Annual", start_date: "2026-05-06", end_date: "2026-05-04", reason: "x" },
      { type: "Annual", start_date: "2026-02-30", end_date: "2026-03-01", reason: "x" },
      { type: "Annual", start_date: "2026-05-04", end_date: "2026-05-04", reason: "   " },
      { type: "Annual", start_date: "2026-01-01", end_date: "2027-06-01", reason: "x" },
    ];
    let allBad = true;
    for (const body of badBodies) allBad &&= (await call("e1", "POST", "/leaves", body)).status === 400;
    check("a foreign or server-owned field, a bad type, reversed or impossible dates, a blank reason and an absurd range are all 400", allBad, "");
    check("...and none of them wrote a row", (await liveCount()) === beforeBad, "");

    // ======================================================================
    // The balance endpoint, against the real view
    // ======================================================================
    const march = await balance("e1", "?as_of=2026-03-20");
    check("GET /leave-balances (employee, default target) -> 200 and it is their own", march.status === 200 && march.body.data.employee_id === e1.employeeId, showing(march));
    check("a pending request reserves its days: March monthly pool is 2 entitled, 0 approved, 2 pending, 0 remaining",
      showing(march.body?.data?.pools?.monthly) === showing({ period: { year: 2026, month: 3 }, entitlement: 2, approved: 0, pending: 2, remaining: 0 }), showing(march.body?.data?.pools));
    check("the serious-need pool is separate and untouched: 14 entitled, 14 remaining",
      march.body?.data?.pools?.serious_need?.entitlement === 14 && march.body.data.pools.serious_need.remaining === 14, showing(march.body?.data?.pools?.serious_need));
    check("the response maps every type to its pool, with Maternity on none",
      showing(march.body?.data?.types) === showing({ Annual: "monthly", Sick: "serious_need", Casual: "monthly", Maternity: null, Emergency: "serious_need" }), showing(march.body?.data?.types));
    check("the next month starts fresh at 2 -- nothing carries forward", (await balance("e1", "?as_of=2026-04-02")).body?.data?.pools?.monthly?.remaining === 2, "");
    check("as_of defaults to today in the company timezone", (await balance("e1")).body?.data?.as_of === today, "");

    // ======================================================================
    // Over-balance and overlap refusals
    // ======================================================================
    const over = await apply("e1", "Casual", "2026-03-20");
    check("a Casual day in March, with March's 2 already reserved (Annual and Casual share one pool) -> 409 leave_balance_exceeded",
      over.status === 409 && over.body.error.code === "leave_balance_exceeded", showing(over));
    check("...with the pool, period and numbers in details",
      showing(over.body?.error?.details) === showing({ pool: "monthly", period: { year: 2026, month: 3 }, entitlement: 2, used: 2, requested: 1, remaining: 0 }), showing(over.body?.error?.details));
    const overlap = await apply("e1", "Annual", "2026-03-11", "2026-03-12");
    check("a request sharing a day with a pending leave -> 409 leave_overlaps naming it (checked before the balance)",
      overlap.status === 409 && overlap.body.error.code === "leave_overlaps" && overlap.body.error.details?.existing_id === l1?.id, showing(overlap));
    check("an unrelated month, fresh: April 1-2 -> 201", (await apply("e1", "Annual", "2026-04-01", "2026-04-02")).status === 201, "");
    const threeDays = await apply("e1", "Annual", "2026-05-04", "2026-05-06");
    check("3 days in a fresh month -> 409 (requested 3, remaining 2)",
      threeDays.status === 409 && threeDays.body.error.details?.requested === 3 && threeDays.body.error.details?.remaining === 2, showing(threeDays));
    check("backdating is allowed (no future/past limit) -> 201", (await apply("e1", "Annual", "2025-01-06")).status === 201, "");
    check("none of the refused requests wrote a row", (await pool.query(
      "SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1 AND deleted_at IS NULL", [e1.employeeId])).rows[0].n === 3, "");

    // ---- Maternity: outside both pools ----
    const mat = await apply("e1", "Maternity", "2026-03-12", "2026-03-14");
    check("Maternity beside a full month, adjacent but not overlapping -> 201 (exempt from the pools)", mat.status === 201, showing(mat));
    const longMat = await apply("e1", "Maternity", "2026-06-01", "2026-08-31");
    check("a three-month Maternity request -> 201 (far beyond any pool)", longMat.status === 201, showing(longMat));
    check("Maternity is still refused when it overlaps another leave -> 409 leave_overlaps",
      errorOf(await apply("e1", "Maternity", "2026-03-14", "2026-03-20")) === "409 leave_overlaps", "");
    check("Maternity days appear in the view yet leave the pools alone: March monthly is still 2 pending, serious-need still 0",
      (await balance("e1", "?as_of=2026-03-20")).body?.data?.pools?.monthly?.pending === 2
      && (await balance("e1", "?as_of=2026-07-01")).body?.data?.pools?.serious_need?.pending === 0, "");

    // ---- December is 12 ----
    const dec12 = await apply("eDec", "Annual", "2026-12-01", "2026-12-12");
    check("December: 12 days -> 201 (the monthly 2 plus the Christmas 10)", dec12.status === 201, showing(dec12));
    const decMore = await apply("eDec", "Casual", "2026-12-13");
    check("December: a 13th day, in a different Annual/Casual type -> 409 with entitlement 12 and used 12",
      decMore.status === 409 && decMore.body.error.details?.entitlement === 12 && decMore.body.error.details?.used === 12, showing(decMore));
    const dec13 = await apply("eDec2", "Annual", "2026-12-01", "2026-12-13");
    check("December: 13 days in one request -> 409 (entitlement 12, requested 13)",
      dec13.status === 409 && dec13.body.error.details?.entitlement === 12 && dec13.body.error.details?.requested === 13, showing(dec13));
    check("the Christmas bonus is December's alone: November is back to 2 (3 days -> 409, entitlement 2)",
      (await apply("eNov", "Annual", "2026-11-02", "2026-11-04")).body?.error?.details?.entitlement === 2, "");
    check("the December balance reads 12 entitled, 12 pending, 0 remaining",
      showing((await balance("admin", `?employee_id=${eDec.employeeId}&as_of=2026-12-15`)).body?.data?.pools?.monthly)
        === showing({ period: { year: 2026, month: 12 }, entitlement: 12, approved: 0, pending: 12, remaining: 0 }), "");

    // ---- a leave spanning a month boundary, through the whole stack ----
    const spanned = await apply("eSpan", "Annual", "2026-01-30", "2026-02-02");
    check("30 Jan - 2 Feb -> 201: judged per month (2 + 2), though 4 days would never fit one month", spanned.status === 201, showing(spanned));
    check("VIEW (written by the API): Jan 2 pending, Feb 2 pending", showing(asKeys(await viewRows(eSpan.employeeId))) === showing(["Annual|2026|1|0|2", "Annual|2026|2|0|2"]),
      showing(asKeys(await viewRows(eSpan.employeeId))));
    check("the balance as of 31 Jan shows January's 2 reserved; as of 15 Feb shows February's 2; as of 1 Mar shows 0",
      (await balance("eSpan", "?as_of=2026-01-31")).body?.data?.pools?.monthly?.pending === 2
      && (await balance("eSpan", "?as_of=2026-02-15")).body?.data?.pools?.monthly?.pending === 2
      && (await balance("eSpan", "?as_of=2026-03-01")).body?.data?.pools?.monthly?.pending === 0, "");
    const spanFeb = await apply("eSpan", "Casual", "2026-02-10");
    check("February is now full, so another February day -> 409 naming FEBRUARY as the period",
      spanFeb.status === 409 && showing(spanFeb.body.error.details?.period) === showing({ year: 2026, month: 2 }), showing(spanFeb));
    check("...while March, untouched, takes a day -> 201", (await apply("eSpan", "Casual", "2026-03-05")).status === 201, "");
    const spanApproved = await call("hr", "PATCH", `/leaves/${spanned.body?.data?.id}`, { status: "approved" });
    check("approving it moves the numbers from pending to approved in BOTH months (view)",
      spanApproved.status === 200 && showing(asKeys(await viewRows(eSpan.employeeId)).filter((key) => key.startsWith("Annual")))
        === showing(["Annual|2026|1|2|0", "Annual|2026|2|2|0"]), showing(asKeys(await viewRows(eSpan.employeeId))));
    check("an approved leave still counts: February stays full (Casual Feb 11 -> 409)", errorOf(await apply("eSpan", "Casual", "2026-02-11")) === "409 leave_balance_exceeded", "");
    const spanDeleted = await call("admin", "DELETE", `/leaves/${spanned.body?.data?.id}`);
    check("admin deleting the approved spanning leave -> 204, and it leaves BOTH months at once (view)",
      spanDeleted.status === 204 && !asKeys(await viewRows(eSpan.employeeId)).some((key) => key.startsWith("Annual|2026|1|") || key.startsWith("Annual|2026|2|")),
      showing(asKeys(await viewRows(eSpan.employeeId))));
    check("...and the freed days can be applied for again -> 201", (await apply("eSpan", "Casual", "2026-02-10")).status === 201, "");

    // ---- the serious-need pool: 14 per calendar year ----
    check("serious-need: 14 Sick days -> 201", (await apply("eSN", "Sick", "2026-04-01", "2026-04-14")).status === 201, "");
    const snOver = await apply("eSN", "Emergency", "2026-09-01");
    check("a 15th day, as Emergency (Sick and Emergency share the pool) -> 409 serious_need, period the YEAR",
      snOver.status === 409 && snOver.body.error.details?.pool === "serious_need" && showing(snOver.body.error.details?.period) === showing({ year: 2026 })
      && snOver.body.error.details?.used === 14, showing(snOver));
    check("the pools are independent: with serious-need full, an Annual day is fine -> 201", (await apply("eSN", "Annual", "2026-04-20")).status === 201, "");
    check("granted EVERY year: the next calendar year has a fresh 14 -> 201", (await apply("eSN", "Sick", "2027-04-01", "2027-04-14")).status === 201, "");
    const sn15 = await apply("eSN2", "Sick", "2026-04-01", "2026-04-15");
    check("15 days in one request -> 409 (requested 15, remaining 14)", sn15.status === 409 && sn15.body.error.details?.requested === 15 && sn15.body.error.details?.remaining === 14, showing(sn15));
    check("a Sick leave across New Year (31 Dec - 2 Jan) -> 201, and each calendar year is charged only its own days",
      (await apply("eSN3", "Sick", "2026-12-31", "2027-01-02")).status === 201
      && (await balance("eSN3", "?as_of=2026-12-31")).body?.data?.pools?.serious_need?.pending === 1
      && (await balance("eSN3", "?as_of=2027-01-10")).body?.data?.pools?.serious_need?.pending === 2, "");

    // ---- the joined_on rules ----
    const preJoin = await apply("eNew", "Annual", "2026-05-10");
    check("a leave in a month BEFORE joining (joined 2026-06-15, leave 2026-05-10) -> 409 with entitlement 0",
      preJoin.status === 409 && preJoin.body.error.details?.entitlement === 0, showing(preJoin));
    check("the month of joining carries the full 2, unprorated, even though only 15 days remain -> 201",
      (await apply("eNew", "Annual", "2026-06-29", "2026-06-30")).status === 201, "");
    check("a mid-year joiner still gets the full December 12 -> 201", (await apply("eNew", "Annual", "2026-12-01", "2026-12-12")).status === 201, "");
    check("their balance before joining shows 0 monthly entitlement; in the joining month 2",
      (await balance("eNew", "?as_of=2026-05-10")).body?.data?.pools?.monthly?.entitlement === 0
      && (await balance("eNew", "?as_of=2026-06-30")).body?.data?.pools?.monthly?.entitlement === 2, "");

    // ======================================================================
    // Decide: every role, scope, immutability
    // ======================================================================
    const decideAs = (as, id, status) => call(as, "PATCH", `/leaves/${id}`, { status });
    const e2Leaves = {};
    for (const [key, type, date] of [
      ["hr", "Annual", "2026-03-02"], ["admin", "Casual", "2026-04-02"], ["manager", "Annual", "2026-05-04"],
      ["tl1", "Annual", "2026-06-04"], ["employee", "Annual", "2026-07-06"], ["tl2", "Annual", "2026-08-03"],
      ["delEmployee", "Annual", "2026-09-07"], ["delTl", "Annual", "2026-10-05"],
    ]) {
      e2Leaves[key] = (await apply("e2", type, date)).body?.data;
    }
    const decidedRow = async (id) => (await leaveRow(id));

    for (const [label, statusWanted] of [["hr", "approved"], ["admin", "rejected"], ["manager", "approved"], ["tl1", "approved"]]) {
      const response = await decideAs(label, e2Leaves[label]?.id, statusWanted);
      const row = await decidedRow(e2Leaves[label]?.id);
      check(`PATCH as ${label} (${statusWanted}) on an in-scope request -> 200, recorded with the decider and time`,
        response.status === 200 && row.status === statusWanted && row.decided_by_employee_id === principals[label].employeeId && row.decided_at !== null && row.decision_recorded === true, showing(response));
    }
    check("the employee role cannot decide -> 403 role_not_allowed, and the row is untouched",
      errorOf(await decideAs("e1", e2Leaves.employee?.id, "approved")) === "403 role_not_allowed" && (await decidedRow(e2Leaves.employee?.id)).status === "pending", "");
    check("a tl outside the employee's team (tl2) -> 403 leave_scope_denied", errorOf(await decideAs("tl2", e2Leaves.employee?.id, "approved")) === "403 leave_scope_denied", "");
    check("a tl and a manager from another department -> 403 leave_scope_denied",
      errorOf(await decideAs("tlB", e2Leaves.employee?.id, "approved")) === "403 leave_scope_denied"
      && errorOf(await decideAs("mgrB", e2Leaves.employee?.id, "approved")) === "403 leave_scope_denied", "");
    check("...and none of those refusals changed the row", (await decidedRow(e2Leaves.employee?.id)).status === "pending", "");
    check("admin can decide a request in another department (eB's) -> 200", await (async () => {
      const bLeave = (await apply("eB", "Annual", "2026-03-03")).body?.data;
      return (await decideAs("admin", bLeave?.id, "approved")).status === 200;
    })(), "");

    // ---- immutability ----
    const rowBefore = await decidedRow(e2Leaves.hr?.id);
    const second = await decideAs("admin", e2Leaves.hr?.id, "rejected");
    const rowAfter = await decidedRow(e2Leaves.hr?.id);
    check("deciding an already-APPROVED leave again -> 409 leave_already_decided", errorOf(second) === "409 leave_already_decided", showing(second));
    check("...and the row, its decider and its decision time are exactly as before",
      rowAfter.status === rowBefore.status && rowAfter.decided_by_employee_id === rowBefore.decided_by_employee_id && +rowAfter.decided_at === +rowBefore.decided_at, "");
    check("an already-REJECTED leave cannot be approved either -> 409", errorOf(await decideAs("hr", e2Leaves.admin?.id, "approved")) === "409 leave_already_decided", "");
    check("a decision cannot put a request back to pending, or carry other fields -> 400",
      (await call("admin", "PATCH", `/leaves/${e2Leaves.delTl?.id}`, { status: "pending" })).status === 400
      && (await call("admin", "PATCH", `/leaves/${e2Leaves.delTl?.id}`, { status: "approved", reason: "edit" })).status === 400
      && (await decidedRow(e2Leaves.delTl?.id)).status === "pending", "");

    // ---- rejecting frees the days ----
    await apply("eRej", "Annual", "2026-04-06", "2026-04-07");
    const rejTarget = (await pool.query("SELECT id FROM leaves WHERE employee_id = $1", [eRej.employeeId])).rows[0].id;
    check("April is full for eRej -> a further day is 409", errorOf(await apply("eRej", "Casual", "2026-04-20")) === "409 leave_balance_exceeded", "");
    check("a manager rejects the pending request -> 200", (await decideAs("manager", rejTarget, "rejected")).status === 200, "");
    check("VIEW: the rejected leave's rows are gone", (await viewRows(eRej.employeeId)).length === 0, showing(await viewRows(eRej.employeeId)));
    check("...so the days are free again -> 201", (await apply("eRej", "Casual", "2026-04-20")).status === 201, "");
    check("a rejected leave does not block re-applying for the same dates -> 201", (await apply("eRej", "Annual", "2026-04-06")).status === 201, "");

    // ======================================================================
    // Self-decision: refused by the DATABASE, surfacing as 403
    // ======================================================================
    for (const label of ["admin", "hr", "manager"]) {
      const own = ownLeaves[label];
      const response = await decideAs(label, own?.id, "approved");
      const row = await decidedRow(own?.id);
      check(`${label} deciding their OWN request -> 403 self_approval_denied (the service let it through; leaves_no_self_approval refused it)`,
        errorOf(response) === "403 self_approval_denied", showing(response));
      check(`...and nothing was written for ${label}'s request: still pending, no decider, no decision time`,
        row.status === "pending" && row.decided_by_employee_id === null && row.decided_at === null, showing(row));
    }
    const tlSelf = await decideAs("tl1", ownLeaves.tl1?.id, "approved");
    check("a tl deciding their own request -> 403 leave_scope_denied (refused earlier, by scope: their own request is not in their own team)",
      errorOf(tlSelf) === "403 leave_scope_denied", showing(tlSelf));
    check("the same requests ARE decidable by someone else: hr approves the admin's -> 200, admin approves hr's -> 200",
      (await decideAs("hr", ownLeaves.admin?.id, "approved")).status === 200 && (await decideAs("admin", ownLeaves.hr?.id, "approved")).status === 200, "");

    const promLeave = (await apply("eProm", "Annual", "2026-03-16")).body?.data;
    await pool.query("UPDATE users SET role = 'manager' WHERE id = $1", [eProm.userId]);
    principals.promotedAsManager = { userId: eProm.userId, employeeId: eProm.employeeId, role: "manager", departmentId: deptA };
    const selfProm = await decideAs("promotedAsManager", promLeave?.id, "approved");
    check("an employee promoted to manager deciding their OWN pending leave -> 403 self_approval_denied (inside their own department scope)",
      errorOf(selfProm) === "403 self_approval_denied" && (await decidedRow(promLeave?.id)).status === "pending", showing(selfProm));
    check("the same leave is decidable by another manager-scope role -> 200", (await decideAs("manager", promLeave?.id, "approved")).status === 200, "");

    // ---- the three raw-SQL constraints, directly ----
    let error = await rawError(
      "UPDATE leaves SET status = 'approved', decided_by_employee_id = employee_id, decided_at = now() WHERE id = $1", [ownLeaves.tl1?.id]);
    check("raw SQL: approving one's own leave -> 23514 leaves_no_self_approval", error?.code === "23514" && error.constraint === "leaves_no_self_approval", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE leaves SET decided_by_employee_id = $2 WHERE id = $1", [ownLeaves.tl1?.id, admin.employeeId]);
    check("raw SQL: a decider on a still-pending leave -> 23514 leaves_decision_consistent", error?.code === "23514" && error.constraint === "leaves_decision_consistent", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE leaves SET end_date = start_date - 1 WHERE id = $1", [ownLeaves.tl1?.id]);
    check("raw SQL: end before start -> 23514 leaves_dates_ordered", error?.code === "23514" && error.constraint === "leaves_dates_ordered", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE leaves SET deleted_by_employee_id = $2 WHERE id = $1", [ownLeaves.tl1?.id, admin.employeeId]);
    check("raw SQL: a deleter on a LIVE leave -> 23514 leaves_deleted_by_requires_deleted_at (migration 010's CHECK)",
      error?.code === "23514" && error.constraint === "leaves_deleted_by_requires_deleted_at", `${error?.code} ${error?.constraint}`);
    error = await rawError(
      "INSERT INTO leaves (employee_id, type, start_date, end_date, reason, applied_on) VALUES ($1, 'Annual', '2026-01-01', '2026-01-01', 'x', '2026-01-01')", [randomUUID()]);
    check("raw SQL: a leave for an unknown employee -> 23503 leaves_employee_id_fkey", error?.code === "23503" && error.constraint === "leaves_employee_id_fkey", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE leaves SET deleted_at = now(), deleted_by_employee_id = $2 WHERE id = $1", [ownLeaves.tl1?.id, randomUUID()]);
    check("raw SQL: an unknown deleter -> 23503 leaves_deleted_by_employee_id_fkey", error?.code === "23503" && error.constraint === "leaves_deleted_by_employee_id_fkey", `${error?.code} ${error?.constraint}`);
    try {
      await container.leaveRepository.decide(ownLeaves.tl1?.id, { status: "approved", decidedByEmployeeId: randomUUID() });
      record("repository.decide with an unknown decider", false, "did not throw");
    } catch (e) {
      check("repository.decide with an unknown decider -> 400 invalid_reference (the FK name flows through the translator)", e.statusCode === 400 && e.code === "invalid_reference", `${e.statusCode} ${e.code}`);
    }
    try {
      await container.leaveRepository.create({ employee_id: randomUUID(), type: "Annual", start_date: "2026-01-01", end_date: "2026-01-01", reason: "x", applied_on: today }, async () => {});
      record("repository.create for an unknown employee", false, "did not throw");
    } catch (e) {
      check("repository.create for an unknown employee -> 400 invalid_employee, and the transaction is rolled back", e.statusCode === 400 && e.code === "invalid_employee", `${e.statusCode} ${e.code}`);
    }

    // ======================================================================
    // Delete: an employee's own cancel, and admin/hr corrections
    // ======================================================================
    const pendingOnes = (await pool.query("SELECT id, status FROM leaves WHERE employee_id = $1 AND deleted_at IS NULL ORDER BY start_date", [e1.employeeId])).rows;
    const e1Pending = pendingOnes.find((row) => row.id !== l1?.id && row.status === "pending");
    const cancelled = await call("e1", "DELETE", `/leaves/${e1Pending?.id}`);
    const cancelledRow = await leaveRow(e1Pending?.id);
    check("an employee cancels their OWN pending leave -> 204", cancelled.status === 204, showing(cancelled));
    check("...a soft delete: the row remains with deleted_at set and the employee recorded as the deleter",
      cancelledRow?.deleted_at !== null && cancelledRow.deleted_by_employee_id === e1.employeeId, showing(cancelledRow));
    check("a cancelled leave is gone from GET, the list, PATCH and a second DELETE",
      (await call("admin", "GET", `/leaves/${e1Pending?.id}`)).status === 404
      && !(await call("admin", "GET", "/leaves")).body.data.some((row) => row.id === e1Pending?.id)
      && (await decideAs("admin", e1Pending?.id, "approved")).status === 404
      && (await call("e1", "DELETE", `/leaves/${e1Pending?.id}`)).status === 404, "");

    check("the employee's own APPROVED leave cannot be cancelled -> 409 leave_already_decided, row intact",
      await (async () => {
        const approvedFirst = (await decideAs("tl1", l1?.id, "approved")).status === 200;
        const refused = await call("e1", "DELETE", `/leaves/${l1?.id}`);
        return approvedFirst && errorOf(refused) === "409 leave_already_decided" && (await leaveRow(l1?.id)).deleted_at === null;
      })(), "");
    check("the employee's own REJECTED leave cannot be cancelled either -> 409",
      errorOf(await call("e2", "DELETE", `/leaves/${e2Leaves.admin?.id}`)) === "409 leave_already_decided", "");

    const delTarget = e2Leaves.delEmployee?.id;
    check("another employee cannot delete it -> 403 leave_scope_denied", errorOf(await call("e1", "DELETE", `/leaves/${delTarget}`)) === "403 leave_scope_denied", "");
    check("the employee's own tl (who CAN decide it) cannot delete it -> 403", errorOf(await call("tl1", "DELETE", `/leaves/${delTarget}`)) === "403 leave_scope_denied", "");
    check("the department's manager (who CAN decide it) cannot delete it -> 403", errorOf(await call("manager", "DELETE", `/leaves/${delTarget}`)) === "403 leave_scope_denied", "");
    check("...and none of those refusals deleted anything", (await leaveRow(delTarget)).deleted_at === null, "");
    const hrDelete = await call("hr", "DELETE", `/leaves/${delTarget}`);
    check("hr deletes a pending leave of someone else -> 204, hr recorded as the deleter",
      hrDelete.status === 204 && (await leaveRow(delTarget)).deleted_by_employee_id === hr.employeeId, showing(hrDelete));
    const adminDelete = await call("admin", "DELETE", `/leaves/${e2Leaves.hr?.id}`);
    check("admin deletes an APPROVED leave -> 204, admin recorded", adminDelete.status === 204 && (await leaveRow(e2Leaves.hr?.id)).deleted_by_employee_id === admin.employeeId, showing(adminDelete));
    check("hr deletes a REJECTED leave -> 204", (await call("hr", "DELETE", `/leaves/${e2Leaves.admin?.id}`)).status === 204, "");
    check("deleted leaves count nowhere: e2's March 2 and April 2 usage is gone from the view",
      !asKeys(await viewRows(e2.employeeId)).some((key) => key.startsWith("Annual|2026|3|") || key.startsWith("Casual|2026|4|")), showing(asKeys(await viewRows(e2.employeeId))));
    check("a malformed id is 404 for PATCH and DELETE", (await call("admin", "DELETE", "/leaves/not-a-uuid")).status === 404 && (await decideAs("admin", "not-a-uuid", "approved")).status === 404, "");

    // ---- ON DELETE SET NULL on the deleter ----
    const disposable = await person("disposable", "admin", deptA);
    const disposableLeaveId = await rawLeave(e3.employeeId, "Annual", "2026-02-09", "2026-02-09");
    await container.leaveRepository.deleteById(disposableLeaveId, disposable.employeeId, { pendingOnly: false });
    check("the repository records an arbitrary deleter", (await leaveRow(disposableLeaveId)).deleted_by_employee_id === disposable.employeeId, "");
    await pool.query("DELETE FROM employees WHERE id = $1", [disposable.employeeId]);
    const orphaned = await leaveRow(disposableLeaveId);
    check("hard-deleting the deleter succeeds and ON DELETE SET NULL clears the pointer, keeping deleted_at",
      orphaned.deleted_by_employee_id === null && orphaned.deleted_at !== null, showing(orphaned));
    try {
      await container.leaveRepository.deleteById(randomUUID(), admin.employeeId, { pendingOnly: false });
      record("leaveRepository.deleteById on a missing id", false, "did not throw");
    } catch (e) {
      check("leaveRepository.deleteById on a missing id -> 404", e.statusCode === 404, `${e.statusCode} ${e.code}`);
    }
    check("repository.decide on a missing id -> null", (await container.leaveRepository.decide(randomUUID(), { status: "approved", decidedByEmployeeId: admin.employeeId })) === null, "");

    // ======================================================================
    // GET /leave-balances scoping, against real employees
    // ======================================================================
    const status = async (as, targetId) => (await balance(as, `?employee_id=${targetId}`)).status;
    check("employee: own balance 200; a colleague on the same team, another team, another department -> 404",
      (await status("e1", e1.employeeId)) === 200 && (await status("e1", e2.employeeId)) === 404
      && (await status("e1", e3.employeeId)) === 404 && (await status("e1", eB.employeeId)) === 404, "");
    check("tl1: their team (e1, e2) and themselves -> 200; another team's e3, another department's eB -> 404",
      (await status("tl1", e1.employeeId)) === 200 && (await status("tl1", e2.employeeId)) === 200 && (await status("tl1", tl1.employeeId)) === 200
      && (await status("tl1", e3.employeeId)) === 404 && (await status("tl1", eB.employeeId)) === 404, "");
    check("manager (department A): both teams -> 200; department B's eB -> 404",
      (await status("manager", e1.employeeId)) === 200 && (await status("manager", e3.employeeId)) === 200 && (await status("manager", eB.employeeId)) === 404, "");
    check("admin and hr: any employee, any department -> 200",
      (await status("admin", eB.employeeId)) === 200 && (await status("hr", eB.employeeId)) === 200 && (await status("hr", e3.employeeId)) === 200, "");
    check("an unknown employee_id is the same 404 as an out-of-scope one",
      errorOf(await balance("e1", `?employee_id=${randomUUID()}`)) === "404 not_found" && errorOf(await balance("e1", `?employee_id=${e3.employeeId}`)) === "404 not_found", "");
    check("a bad query is 400 (malformed employee_id, impossible as_of, an unknown parameter)",
      (await balance("admin", "?employee_id=nope")).status === 400 && (await balance("admin", "?as_of=2026-02-30")).status === 400 && (await balance("admin", "?year=2026")).status === 400, "");
    const rawJoined = (await pool.query("SELECT joined_on FROM employees WHERE id = $1", [eNew.employeeId])).rows[0].joined_on;
    check("control: joined_on read through pg is a JS Date, which is why the balance reads it as text",
      rawJoined instanceof Date, showing(rawJoined));
    check("the balance still gets joined_on right: before 2026-06-15 no monthly entitlement, from the joining month on 2",
      (await balance("admin", `?employee_id=${eNew.employeeId}&as_of=2026-05-31`)).body?.data?.pools?.monthly?.entitlement === 0
      && (await balance("admin", `?employee_id=${eNew.employeeId}&as_of=2026-06-01`)).body?.data?.pools?.monthly?.entitlement === 2, "");

    // ======================================================================
    // Real concurrency: the per-employee lock
    // ======================================================================
    // RACE 1: a burst. 8 concurrent applies for 8 different single days of one month; the monthly
    // pool is 2. Without the lock, READ COMMITTED lets all 8 read the same usage and all pass.
    const burstDays = [1, 2, 3, 4, 5, 6, 7, 8].map((day) => `2026-10-0${day}`);
    const burst = await Promise.all(burstDays.map((day) => apply("eRace1", "Annual", day)));
    const burstOk = burst.filter((response) => response.status === 201).length;
    const burstRefused = burst.filter((response) => response.status === 409 && response.body.error.code === "leave_balance_exceeded").length;
    check(`RACE 1: 8 concurrent applies against a 2-day month admit exactly 2 (201) and refuse 6 (409 leave_balance_exceeded) -- got ${burstOk}/${burstRefused}`,
      burstOk === 2 && burstRefused === 6, showing(burst.map((response) => response.status)));
    check("RACE 1: the database holds exactly 2 live leaves for that month (never 3 or more)",
      (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1 AND deleted_at IS NULL", [eRace1.employeeId])).rows[0].n === 2, "");
    check("RACE 1: the view agrees -- 2 pending days in October", showing(asKeys(await viewRows(eRace1.employeeId))) === showing(["Annual|2026|10|0|2"]), showing(asKeys(await viewRows(eRace1.employeeId))));

    // RACE 2: identical requests. Exactly one wins; the rest are refused as overlapping.
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => apply("eRace2", "Casual", "2026-11-10")));
    check("RACE 2: 5 concurrent IDENTICAL applies -> exactly one 201, four 409 leave_overlaps",
      same.filter((r) => r.status === 201).length === 1 && same.filter((r) => errorOf(r) === "409 leave_overlaps").length === 4, showing(same.map((r) => errorOf(r))));
    check("RACE 2: exactly one row exists", (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1", [eRace2.employeeId])).rows[0].n === 1, "");

    // RACE 3: a holder transaction. Another apply for this employee is in flight (employee locked,
    // 2 days inserted, uncommitted). A second apply must WAIT, then see those days and refuse.
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [eRace3.employeeId]);
        await holder.query(
          `INSERT INTO leaves (employee_id, type, start_date, end_date, reason, applied_on)
           VALUES ($1, 'Annual', '2027-03-01', '2027-03-02', 'in flight', $2)`, [eRace3.employeeId, today]);
        let settled = false;
        const pending = apply("eRace3", "Annual", "2027-03-15").then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 3: an apply WAITS while another apply for the same employee is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await pending;
        check("RACE 3: once the first commits, the waiting apply sees its 2 days and refuses -> 409 leave_balance_exceeded with used 2",
          errorOf(response) === "409 leave_balance_exceeded" && response.body.error.details?.used === 2, showing(response));
        check("RACE 3: only the holder's row exists", (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1", [eRace3.employeeId])).rows[0].n === 1, "");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }

    // RACE 4: the lock must NOT block other work. While one employee's row is locked, a raw insert of
    // a leave for that same employee (a foreign-key check, KEY SHARE) and an apply by a different
    // employee both finish promptly. FOR UPDATE would have blocked the first; a table lock both.
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM employees WHERE id = $1 FOR NO KEY UPDATE", [eRace4.employeeId]);
        const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
        const fkInsert = await within(rawLeave(eRace4.employeeId, "Casual", "2026-02-02", "2026-02-02"), 3000);
        check("RACE 4: a foreign-key check on the locked employee (a raw leave insert) is NOT blocked by the apply lock", fkInsert, "it waited -- the lock is too strong");
        const fkDecider = await within(rawLeave(e3.employeeId, "Casual", "2026-02-03", "2026-02-03", "approved").then(async (id) => (
          pool.query("UPDATE leaves SET decided_by_employee_id = $2 WHERE id = $1", [id, eRace4.employeeId]))), 3000);
        check("RACE 4: nor is a leave decided BY the locked employee (a foreign key to them)", fkDecider, "it waited");
        const otherEmployee = await within(apply("e3", "Annual", "2026-03-23"), 3000);
        check("RACE 4: an apply by a DIFFERENT employee proceeds while the lock is held", otherEmployee, "it waited");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }

    // RACE 5/6/7: the guarded UPDATEs. A decision is in flight (row locked, uncommitted) when another
    // decision or an own-cancel arrives; each must wait and then be refused, not overwrite.
    const racer = async (date) => (await apply("eRace5", "Annual", date)).body?.data;
    const raceDecideTarget = await racer("2026-01-12");
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "UPDATE leaves SET status = 'approved', decided_by_employee_id = $2, decided_at = now() WHERE id = $1 AND status = 'pending'",
          [raceDecideTarget?.id, admin.employeeId]);
        let settled = false;
        const rejection = decideAs("hr", raceDecideTarget?.id, "rejected").then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 5: a decision WAITS while another decision on the same leave is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await rejection;
        const row = await leaveRow(raceDecideTarget?.id);
        check("RACE 5: once the first commits, the second is refused -> 409 leave_already_decided", errorOf(response) === "409 leave_already_decided", showing(response));
        check("RACE 5: the FIRST decision stands -- approved by the admin, not overwritten by hr's rejection",
          row.status === "approved" && row.decided_by_employee_id === admin.employeeId, showing(row));
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }
    const raceCancelTarget = await racer("2026-02-16");
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "UPDATE leaves SET status = 'approved', decided_by_employee_id = $2, decided_at = now() WHERE id = $1 AND status = 'pending'",
          [raceCancelTarget?.id, tl1.employeeId]);
        let settled = false;
        const cancel = call("eRace5", "DELETE", `/leaves/${raceCancelTarget?.id}`).then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 6: the employee's own cancel WAITS while an approval of that leave is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await cancel;
        const row = await leaveRow(raceCancelTarget?.id);
        check("RACE 6: the service read 'pending' a moment earlier, but the guarded UPDATE refuses -> 409 leave_already_decided",
          errorOf(response) === "409 leave_already_decided", showing(response));
        check("RACE 6: the leave is approved and NOT deleted -- a decided leave cannot be cancelled by a race",
          row.status === "approved" && row.deleted_at === null, showing(row));
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }
    const raceDeletedTarget = await racer("2026-03-30");
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("UPDATE leaves SET deleted_at = now(), deleted_by_employee_id = $2 WHERE id = $1", [raceDeletedTarget?.id, admin.employeeId]);
        let settled = false;
        const decision = decideAs("manager", raceDeletedTarget?.id, "approved").then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 7: a decision WAITS while a delete of that leave is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await decision;
        const row = await leaveRow(raceDeletedTarget?.id);
        check("RACE 7: once the delete commits the decision finds no live leave -> 404, and nothing was decided",
          response.status === 404 && row.status === "pending" && row.decided_by_employee_id === null, showing(response));
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
  } else {
    const pool = getPool();
    const tag = `p9e2e-${randomUUID().slice(0, 8)}`;
    let seeding = false;
    try {
      const { rows: [{ current_database: currentDatabase }] } = await pool.query("SELECT current_database()");
      if (!flags.confirmDatabase) {
        throw new Error(`Refusing to run: pass --confirm-database=${currentDatabase} to confirm the target.`);
      }
      if (flags.confirmDatabase !== currentDatabase) {
        throw new Error(`Refusing to run: connected to "${currentDatabase}" but "${flags.confirmDatabase}" was confirmed.`);
      }
      console.info(`database: ${currentDatabase}`);

      // Pre-flight, before anything is written and before cleanup is armed: cleanup's own SQL names
      // the column migration 010 adds, and the whole run needs the replaced view.
      const { rows: [{ present }] } = await pool.query(
        `SELECT (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'leaves' AND column_name = 'deleted_by_employee_id') = 1
            AND (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'employee_leave_usage' AND column_name = 'usage_month') = 1 AS present`,
      );
      if (!present) throw new Error("Migration 010 is not applied to this database; run `npm run db:migrate` first.");

      seeding = true;
      const results = await run(pool, tag);
      const failed = results.filter((result) => !result.ok);
      console.info(`\n${results.length - failed.length} passed, ${failed.length} failed`);
      if (failed.length > 0) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      // Only after the confirmation passed: a refused run must not delete anything.
      if (seeding) {
        try {
          await cleanup(pool, tag);
          const { rows: [{ leftover }] } = await pool.query(
            "SELECT count(*)::int AS leftover FROM users WHERE email LIKE $1", [`${tag}-%@example.invalid`]);
          const { rows: [{ leftoverLeaves }] } = await pool.query(
            `SELECT count(*)::int AS "leftoverLeaves" FROM leaves WHERE reason IN ('e2e', 'e2e raw', 'in flight')
               AND employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)`, [`${tag}-%`]);
          console.info(`cleanup done; leftover seeded users: ${leftover}; leftover leaves: ${leftoverLeaves}`);
        } catch (error) {
          console.error(`CLEANUP FAILED -- rows tagged ${tag} may remain: ${error.message}`);
          process.exitCode = 1;
        }
      }
      await closePool();
    }
  }
}
