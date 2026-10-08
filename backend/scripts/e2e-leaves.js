/**
 * End-to-end check of the Phase 9 leave write endpoints and the leave-balance endpoint against a
 * REAL PostgreSQL database: the real container, repositories, services and routes (over HTTP), with
 * only authentication stubbed. The unit tests run against fakes and cannot see SQL, locks,
 * constraint names, the employee_leave_usage view or pg's date and integer types; this can.
 *
 *   node scripts/e2e-leaves.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL,
 * AUTH_TOKEN_SECRET, COMPANY_TIMEZONE), and migration 011 already applied (`npm run db:migrate`).
 *
 * It writes: departments, users, employees and leaves, all tagged `p9e2e-<random>`. Everything it
 * creates is deleted again in a `finally`, found by that tag rather than by remembered ids, so a run
 * that dies half-way through seeding still cleans up. It never touches a row it did not create.
 * Exits non-zero if any check fails.
 *
 * D40: there are no leave entitlements and no limits, so approval is the only control. This script
 * proves, against the real database: that migration 011 restored employee_leave_usage to the shape
 * it had before 010 (approved leave, per type, per calendar year, attributed whole to the year it
 * starts in) and that the days-taken endpoint reads it correctly, including pg's bigint-as-string;
 * that NOTHING but an overlap can refuse an application (length, number, type and calendar position
 * are all unlimited); that the per-employee FOR NO KEY UPDATE lock really serialises concurrent
 * applies so the overlap check cannot be raced, without blocking other tables' foreign-key checks;
 * that the self-approval ban is the DATABASE's; and that the guarded UPDATEs make a decided leave
 * immutable under a real race.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { getCompanyTimezone } from "../src/config/env.js";
import { getContainer, resetContainer } from "../src/container.js";
import { closePool, getPool } from "../src/db/pool.js";
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
  const person = async (label, role, departmentId, { teamLeadId = null } = {}) => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (company_id, email, role) VALUES ($1, $2, $3) RETURNING id",
      [company.id, `${tag}-${label}@example.invalid`, role]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, team_lead_id, employee_number, full_name, position_title,
                              joined_on, employment_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'E2E', '2024-01-01', 'active') RETURNING id`,
      [user.id, company.id, departmentId, teamLeadId, `${tag}-${label}`, `${tag} ${label}`]);
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
  // One employee per scenario, so no scenario's leave can leak into another's numbers.
  const eView = await person("eView", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eLong = await person("eLong", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eTaken = await person("eTaken", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRej = await person("eRej", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eProm = await person("eProm", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace1 = await person("eRace1", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace2 = await person("eRace2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace3 = await person("eRace3", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace4 = await person("eRace4", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eRace5 = await person("eRace5", "employee", deptA, { teamLeadId: tl1.employeeId });
  principals.noEmployee = { userId: randomUUID(), employeeId: null, role: "admin", departmentId: null };

  // -------------------------------------------------------------------------
  // The schema, against what Postgres actually generated
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
  check("the restored view has exactly employee_id, type, leave_year, days_used, in that order (migration 011 = the pre-010 shape)",
    showing(viewColumns.map((c) => c.column_name)) === showing(["employee_id", "type", "leave_year", "days_used"]),
    showing(viewColumns.map((c) => c.column_name)));
  check("...typed uuid, leave_type, int4, then int8: days_used is sum(integer), a BIGINT, which pg hands back as a string",
    showing(viewColumns.map((c) => c.udt_name)) === showing(["uuid", "leave_type", "int4", "int8"]), showing(viewColumns.map((c) => c.udt_name)));
  try {
    await pool.query("SELECT usage_month FROM employee_leave_usage LIMIT 1");
    record("010's per-month columns are gone (usage_month)", false, "the query succeeded");
  } catch (error) {
    check("010's per-month columns are gone (usage_month -> 42703 undefined_column)", error.code === "42703", `${error.code}`);
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
    // The view as pg returns it RAW: days_used arrives as a string (bigint).
    const viewRows = async (employeeId) => (await pool.query(
      "SELECT type::text AS type, leave_year, days_used FROM employee_leave_usage WHERE employee_id = $1 ORDER BY type, leave_year", [employeeId])).rows;
    const asKeys = (rows) => rows.map((row) => `${row.type}|${row.leave_year}|${row.days_used}`);
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
    // THE RESTORED VIEW (migration 011), against real Postgres
    // ======================================================================
    // Raw inserts (bypassing the API, so the view is judged on its own). Every expected number is worked
    // out by hand from the calendar, not by the code under test.
    await rawLeave(eView.employeeId, "Annual", "2026-03-02", "2026-03-04", "approved");     // 3 days
    await rawLeave(eView.employeeId, "Annual", "2026-05-11", "2026-05-11", "approved");     // +1: same type and year, ONE grouped row
    await rawLeave(eView.employeeId, "Annual", "2026-12-30", "2027-01-02", "approved");     // 4 days; STARTS in 2026, so all 4 count in 2026
    await rawLeave(eView.employeeId, "Casual", "2027-01-04", "2027-01-05", "approved");     // 2
    await rawLeave(eView.employeeId, "Sick", "2028-02-28", "2028-03-01", "approved");       // 3: a leap year, 28 and 29 Feb and 1 Mar
    await rawLeave(eView.employeeId, "Maternity", "2026-08-01", "2026-11-20", "approved");  // 31 + 30 + 31 + 20 = 112 CALENDAR days
    await rawLeave(eView.employeeId, "Sick", "2026-04-01", "2026-04-10", "pending");        // excluded: pending
    await rawLeave(eView.employeeId, "Emergency", "2026-05-01", "2026-05-10", "rejected");  // excluded: rejected
    await rawLeave(eView.employeeId, "Annual", "2026-07-01", "2026-07-05", "approved", { deleted: true }); // excluded: soft-deleted

    const expectedView = ["Annual|2026|8", "Casual|2027|2", "Maternity|2026|112", "Sick|2028|3"];
    const viewNow = await viewRows(eView.employeeId);
    check("VIEW: per employee, type and year, exactly the hand-computed rows", sameSet(asKeys(viewNow), expectedView),
      `expected ${showing(expectedView)} got ${showing(asKeys(viewNow))}`);
    check("VIEW: three approved leaves of one type and year are summed into ONE row (3 + 1 + 4 = 8)",
      viewNow.filter((row) => row.type === "Annual" && row.leave_year === 2026).length === 1 && Number(viewNow.find((row) => row.type === "Annual")?.days_used) === 8, showing(viewNow));
    check("VIEW: a leave is attributed WHOLE to the year it starts in: 30 Dec - 2 Jan counts 4 days in 2026 and leaves no 2027 Annual row",
      !viewNow.some((row) => row.type === "Annual" && row.leave_year === 2027), showing(viewNow));
    check("VIEW: days are calendar days, weekends included, and a leap year is known (28 Feb - 1 Mar 2028 = 3)",
      Number(viewNow.find((row) => row.type === "Sick" && row.leave_year === 2028)?.days_used) === 3, showing(viewNow));
    check("VIEW: Maternity is 112 calendar days across four months",
      Number(viewNow.find((row) => row.type === "Maternity")?.days_used) === 112, showing(viewNow));
    check("VIEW: pending, rejected and soft-deleted leave are never counted (no Emergency row; no 2026 Sick row; Annual is 8, not 13)",
      !viewNow.some((row) => row.type === "Emergency") && !viewNow.some((row) => row.type === "Sick" && row.leave_year === 2026)
      && Number(viewNow.find((row) => row.type === "Annual")?.days_used) === 8, showing(viewNow));
    check("VIEW control: read RAW through pg, days_used is a STRING (bigint) and leave_year a number -- which is why the repository casts",
      typeof viewNow[0]?.days_used === "string" && typeof viewNow[0]?.leave_year === "number", showing(viewNow[0]));
    const throughRepository = await container.leaveRepository.daysTaken(eView.employeeId, 2026);
    check("VIEW: through leaveRepository.daysTaken, days_used arrives as a NUMBER (the ::int cast)",
      Array.isArray(throughRepository) && throughRepository.length === 2
      && throughRepository.every((row) => typeof row.days_used === "number")
      && throughRepository.find((row) => row.type === "Annual")?.days_used === 8
      && throughRepository.find((row) => row.type === "Maternity")?.days_used === 112, showing(throughRepository));
    const { rows: [{ approved_days: approvedDays }] } = await pool.query(
      `SELECT COALESCE(sum(days), 0)::int AS approved_days FROM leaves
       WHERE employee_id = $1 AND status = 'approved' AND deleted_at IS NULL`, [eView.employeeId]);
    const viewDays = viewNow.reduce((sum, row) => sum + Number(row.days_used), 0);
    check(`VIEW: its days add back up to leaves.days over the approved, undeleted leave: ${viewDays} = ${approvedDays}`, viewDays === approvedDays, `${viewDays} vs ${approvedDays}`);
    check("VIEW: another employee has no rows from eView's leave", (await viewRows(e3.employeeId)).length === 0, "");
    check("VIEW: the year filter works -- 2027 holds only the Casual leave, and an empty year gives an empty list",
      showing((await container.leaveRepository.daysTaken(eView.employeeId, 2027)).map((row) => row.type)) === showing(["Casual"])
      && (await container.leaveRepository.daysTaken(eView.employeeId, 2035)).length === 0, "");

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
      l1Row?.employee_id === e1.employeeId && l1Row.decision_recorded === true && l1Row.deleted_at === null && l1Row.deleted_by_employee_id === null && l1Row.days === 2, showing(l1));
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
    ];
    let allBad = true;
    for (const body of badBodies) allBad &&= (await call("e1", "POST", "/leaves", body)).status === 400;
    check("a foreign or server-owned field, a bad type, reversed or impossible dates and a blank reason are all 400", allBad, "");
    check("...and none of them wrote a row", (await liveCount()) === beforeBad, "");

    // ======================================================================
    // The overlap refusal -- the ONE thing that can refuse an application (D40)
    // ======================================================================
    const overlap = await apply("e1", "Annual", "2026-03-11", "2026-03-12");
    check("a request sharing a day with a pending leave -> 409 leave_overlaps naming it",
      overlap.status === 409 && overlap.body.error.code === "leave_overlaps" && overlap.body.error.details?.existing_id === l1?.id, showing(overlap));
    check("a different TYPE does not escape the overlap rule", errorOf(await apply("e1", "Sick", "2026-03-10")) === "409 leave_overlaps", "");
    const mat = await apply("e1", "Maternity", "2026-03-12", "2026-03-14");
    check("Maternity next to it, adjacent but not overlapping -> 201", mat.status === 201, showing(mat));
    check("Maternity is not exempt from the overlap rule either -> 409", errorOf(await apply("e1", "Maternity", "2026-03-14", "2026-03-20")) === "409 leave_overlaps", "");
    check("backdating is allowed -> 201", (await apply("e1", "Annual", "2025-01-06")).status === 201, "");
    check("the refused requests wrote nothing: e1 holds exactly l1, the Maternity leave and the backdated one",
      (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1 AND deleted_at IS NULL", [e1.employeeId])).rows[0].n === 3, "");

    // ======================================================================
    // D40: NO entitlements, NO limits -- nothing but an overlap can refuse
    // ======================================================================
    let tenOk = true;
    for (let day = 1; day <= 10; day += 1) {
      tenOk &&= (await apply("eLong", "Annual", `2026-04-${String(day).padStart(2, "0")}`)).status === 201;
    }
    check("ten one-day requests in the SAME month (the old monthly 2) are all accepted -> 201", tenOk, "");
    const longRequest = await apply("eLong", "Annual", "2030-01-01", "2031-02-04");
    check("a 400-day request (beyond the old 366 sanity bound) -> 201, with days = 400",
      longRequest.status === 201 && longRequest.body.data.days === 400, showing(longRequest));
    check("a 365-day Maternity request (beyond the old 16 weeks) -> 201",
      (await apply("eLong", "Maternity", "2033-01-01", "2033-12-31")).status === 201, "");
    check("30 days of Sick and 30 of Emergency in one year (the old 14) -> 201 each",
      (await apply("eLong", "Sick", "2032-01-01", "2032-01-30")).status === 201
      && (await apply("eLong", "Emergency", "2032-03-01", "2032-03-30")).status === 201, "");
    const crossing = await apply("eLong", "Casual", "2034-12-20", "2035-01-20");
    check("a leave across a year boundary is accepted whole; nothing is split or judged per period",
      crossing.status === 201 && crossing.body.data.days === 32, showing(crossing));
    const weekend = await apply("eLong", "Annual", "2026-05-02", "2026-05-03");  // a Saturday and a Sunday
    check("a Saturday-and-Sunday-only request is accepted, with days = 2: days are calendar days, the working-days rule is gone",
      weekend.status === 201 && weekend.body.data.days === 2, showing(weekend));

    // ======================================================================
    // The days-taken endpoint, against the real (restored) view
    // ======================================================================
    const early = await balance("e1", "?as_of=2026-03-20");
    check("GET /leave-balances (employee, default target) -> 200 and it is their own", early.status === 200 && early.body.data.employee_id === e1.employeeId, showing(early));
    check("the response is employee_id, as_of, year, taken, total -- no entitlement, pool, allowance or remaining",
      showing(Object.keys(early.body?.data ?? {}).sort()) === showing(["as_of", "employee_id", "taken", "total", "year"]), showing(early.body?.data));
    check("all five leave types are present in `taken`, and a PENDING request is not counted: e1's pending leave shows 0",
      sameSet(Object.keys(early.body?.data?.taken ?? {}), ["Annual", "Sick", "Casual", "Maternity", "Emergency"]) && early.body.data.total === 0, showing(early.body?.data));
    check("as_of defaults to today in the company timezone, and its year is reported",
      (await balance("e1")).body?.data?.as_of === today && (await balance("e1")).body?.data?.year === Number(today.slice(0, 4)), "");

    // eTaken: five leaves, then decisions, then what the endpoint reports.
    const a1 = (await apply("eTaken", "Annual", "2026-12-30", "2027-01-02")).body?.data;     // 4 days, starts in 2026
    const s1 = (await apply("eTaken", "Sick", "2026-02-02", "2026-02-06")).body?.data;       // 5 days
    const c1 = (await apply("eTaken", "Casual", "2026-06-01", "2026-06-10")).body?.data;     // 10 days, stays pending
    const x1 = (await apply("eTaken", "Emergency", "2026-07-06", "2026-07-07")).body?.data;  // 2 days, will be rejected
    const m1 = (await apply("eTaken", "Maternity", "2026-08-01", "2026-11-20")).body?.data;  // 112 days
    const takenAt = async (asOf) => (await balance("eTaken", `?as_of=${asOf}`)).body?.data;
    check("with five requests all PENDING, nothing is taken: every type 0, total 0", (await takenAt("2026-12-31"))?.total === 0, showing(await takenAt("2026-12-31")));
    await call("hr", "PATCH", `/leaves/${a1?.id}`, { status: "approved" });
    await call("hr", "PATCH", `/leaves/${s1?.id}`, { status: "approved" });
    await call("hr", "PATCH", `/leaves/${m1?.id}`, { status: "approved" });
    await call("manager", "PATCH", `/leaves/${x1?.id}`, { status: "rejected" });
    const afterDecisions = await takenAt("2026-12-31");
    check("once approved they are counted, per type: Annual 4, Sick 5, Maternity 112; the pending Casual and the rejected Emergency are 0; total 121",
      showing(afterDecisions?.taken) === showing({ Annual: 4, Sick: 5, Casual: 0, Maternity: 112, Emergency: 0 }) && afterDecisions?.total === 121, showing(afterDecisions));
    const nextYear = await takenAt("2027-01-10");
    check("a leave counts in the year it STARTS in: 30 Dec - 2 Jan is 4 days in 2026 and nothing in 2027",
      nextYear?.year === 2027 && nextYear?.total === 0, showing(nextYear));
    check("the numbers arrive as JSON numbers, not strings", Object.values(afterDecisions?.taken ?? {}).every((days) => typeof days === "number") && typeof afterDecisions?.total === "number", "");
    await call("admin", "DELETE", `/leaves/${s1?.id}`);
    check("deleting an approved leave removes it from the count: Sick 0, total 116",
      (await takenAt("2026-12-31"))?.taken?.Sick === 0 && (await takenAt("2026-12-31"))?.total === 116, showing(await takenAt("2026-12-31")));
    await call("hr", "PATCH", `/leaves/${c1?.id}`, { status: "approved" });
    check("approving the pending Casual leave adds its 10 days: Casual 10, total 126",
      (await takenAt("2026-12-31"))?.taken?.Casual === 10 && (await takenAt("2026-12-31"))?.total === 126, showing(await takenAt("2026-12-31")));
    check("the endpoint agrees with the view read directly (126 over 2026)",
      (await viewRows(eTaken.employeeId)).filter((row) => row.leave_year === 2026).reduce((sum, row) => sum + Number(row.days_used), 0) === 126, "");

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

    // ---- a rejected leave does not block re-applying for the same dates ----
    await apply("eRej", "Annual", "2026-04-06", "2026-04-07");
    const rejTarget = (await pool.query("SELECT id FROM leaves WHERE employee_id = $1", [eRej.employeeId])).rows[0].id;
    check("while it is pending, the same dates are an overlap -> 409", errorOf(await apply("eRej", "Annual", "2026-04-06")) === "409 leave_overlaps", "");
    check("a manager rejects the pending request -> 200", (await decideAs("manager", rejTarget, "rejected")).status === 200, "");
    check("a REJECTED leave no longer blocks those dates -> 201", (await apply("eRej", "Annual", "2026-04-06", "2026-04-07")).status === 201, "");
    check("and a rejected leave counts for nothing: eRej has taken 0 days", (await balance("eRej", "?as_of=2026-06-01")).body?.data?.total === 0, "");

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

    // ---- the raw-SQL constraints, directly ----
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
    check("...and its dates are free to apply for again -> 201", (await apply("e1", "Annual", "2025-01-06")).status === 201, "");

    check("the employee's own APPROVED leave cannot be cancelled -> 409 leave_already_decided, row intact",
      await (async () => {
        const approvedFirst = (await decideAs("tl1", l1?.id, "approved")).status === 200;
        const refused = await call("e1", "DELETE", `/leaves/${l1?.id}`);
        return approvedFirst && errorOf(refused) === "409 leave_already_decided" && (await leaveRow(l1?.id)).deleted_at === null;
      })(), "");
    check("e1's approved March leave is now counted: 2 days of Annual in 2026",
      (await balance("e1", "?as_of=2026-06-01")).body?.data?.taken?.Annual === 2, showing((await balance("e1", "?as_of=2026-06-01")).body?.data));
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
    check("employee: own days taken 200; a colleague on the same team, another team, another department -> 404",
      (await status("e1", e1.employeeId)) === 200 && (await status("e1", e2.employeeId)) === 404
      && (await status("e1", e3.employeeId)) === 404 && (await status("e1", eB.employeeId)) === 404, "");
    check("tl1: their team (e1, e2) and themselves -> 200; another team's e3, another department's eB -> 404",
      (await status("tl1", e1.employeeId)) === 200 && (await status("tl1", e2.employeeId)) === 200 && (await status("tl1", tl1.employeeId)) === 200
      && (await status("tl1", e3.employeeId)) === 404 && (await status("tl1", eB.employeeId)) === 404, "");
    check("manager (department A): both teams -> 200; department B's eB -> 404",
      (await status("manager", e1.employeeId)) === 200 && (await status("manager", e3.employeeId)) === 200 && (await status("manager", eB.employeeId)) === 404, "");
    check("admin and hr: any employee, any department -> 200",
      (await status("admin", eB.employeeId)) === 200 && (await status("hr", eB.employeeId)) === 200 && (await status("hr", e3.employeeId)) === 200, "");
    check("an approver reads the same numbers the employee sees: hr reading eTaken gets 126 for 2026",
      (await balance("hr", `?employee_id=${eTaken.employeeId}&as_of=2026-12-31`)).body?.data?.total === 126, "");
    check("an unknown employee_id is the same 404 as an out-of-scope one",
      errorOf(await balance("e1", `?employee_id=${randomUUID()}`)) === "404 not_found" && errorOf(await balance("e1", `?employee_id=${e3.employeeId}`)) === "404 not_found", "");
    check("a bad query is 400 (malformed employee_id, impossible as_of, an unknown parameter)",
      (await balance("admin", "?employee_id=nope")).status === 400 && (await balance("admin", "?as_of=2026-02-30")).status === 400 && (await balance("admin", "?year=2026")).status === 400, "");

    // ======================================================================
    // Real concurrency: the per-employee lock
    // ======================================================================
    // RACE 1: a burst. 8 concurrent applies for 8 DIFFERENT days of one month. With no limits every one
    // is admitted; this proves the lock serialises them without refusing, deadlocking or erroring.
    // (It never discriminated for the lock itself -- RACE 2 and RACE 3 are the proofs of that.)
    const burstDays = [1, 2, 3, 4, 5, 6, 7, 8].map((day) => `2026-10-0${day}`);
    const burst = await Promise.all(burstDays.map((day) => apply("eRace1", "Annual", day)));
    check(`RACE 1: 8 concurrent applies for 8 different days are ALL admitted (201): the lock serialises, it does not refuse -- got ${showing(burst.map((r) => r.status))}`,
      burst.every((response) => response.status === 201), showing(burst.map((r) => errorOf(r))));
    check("RACE 1: the database holds exactly those 8 live leaves",
      (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1 AND deleted_at IS NULL", [eRace1.employeeId])).rows[0].n === 8, "");

    // RACE 2: identical requests. Exactly one wins; the rest are refused as overlapping. Without the
    // lock all five read "no overlap" and all five go in (shown by a control run with the lock removed).
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => apply("eRace2", "Casual", "2026-11-10")));
    check("RACE 2: 5 concurrent IDENTICAL applies -> exactly one 201, four 409 leave_overlaps",
      same.filter((r) => r.status === 201).length === 1 && same.filter((r) => errorOf(r) === "409 leave_overlaps").length === 4, showing(same.map((r) => errorOf(r))));
    check("RACE 2: exactly one row exists", (await pool.query("SELECT count(*)::int AS n FROM leaves WHERE employee_id = $1", [eRace2.employeeId])).rows[0].n === 1, "");

    // RACE 3: a holder transaction. Another apply for this employee is in flight (employee locked, an
    // overlapping leave inserted, uncommitted). A second apply for overlapping dates must WAIT, then see
    // that leave and be refused as an overlap.
    {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [eRace3.employeeId]);
        const { rows: [inFlight] } = await holder.query(
          `INSERT INTO leaves (employee_id, type, start_date, end_date, reason, applied_on)
           VALUES ($1, 'Annual', '2027-03-01', '2027-03-02', 'in flight', $2) RETURNING id`, [eRace3.employeeId, today]);
        let settled = false;
        const pending = apply("eRace3", "Annual", "2027-03-02", "2027-03-03").then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 3: an apply WAITS while another apply for the same employee is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await pending;
        check("RACE 3: once the first commits, the waiting apply sees it and is refused -> 409 leave_overlaps naming the in-flight leave",
          errorOf(response) === "409 leave_overlaps" && response.body.error.details?.existing_id === inFlight.id, showing(response));
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

      // Pre-flight, before anything is written and before cleanup is armed: cleanup's own SQL names the
      // column migration 010 added, and the whole run needs the view as migration 011 restored it
      // (leave_year present, 010's usage_month gone).
      const { rows: [{ present }] } = await pool.query(
        `SELECT (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'leaves' AND column_name = 'deleted_by_employee_id') = 1
            AND (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'employee_leave_usage' AND column_name = 'leave_year') = 1
            AND (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'employee_leave_usage' AND column_name = 'usage_month') = 0 AS present`,
      );
      if (!present) throw new Error("Migration 011 is not applied to this database; run `npm run db:migrate` first.");

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
