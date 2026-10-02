/**
 * End-to-end check of the Phase 6 attendance write endpoints against a REAL PostgreSQL
 * database: the real container, repositories, services and routes (over HTTP), with only
 * authentication stubbed. The unit tests run against fakes and cannot see SQL, constraint names,
 * triggers or partial indexes; this can.
 *
 *   node scripts/e2e-attendance.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL,
 * AUTH_TOKEN_SECRET, COMPANY_TIMEZONE), and migration 007 already applied (`npm run db:migrate`).
 *
 * It writes: departments, users, employees and attendance rows, all tagged `p6e2e-<random>`.
 * Everything it creates is deleted again in a `finally`, found by that tag rather than by
 * remembered ids, so a run that dies half-way through seeding still cleans up. It never
 * touches a row it did not create. Exits non-zero if any check fails.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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

/** Deletes everything this run created, located by TAG. Order respects the foreign keys. */
async function cleanup(pool, tag) {
  const like = `${tag}-%`;
  await pool.query(
    `DELETE FROM attendance
     WHERE employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)
        OR deleted_by_employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)`,
    [like],
  );
  await pool.query("DELETE FROM employees WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}-%@example.invalid`]);
  await pool.query("DELETE FROM departments WHERE name LIKE $1", [like]);
}

async function run(pool, tag) {
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.info(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  };
  const check = (name, condition, detail) => record(name, Boolean(condition), detail);

  const timeZone = getCompanyTimezone();
  console.info(`tag: ${tag}   timezone: ${timeZone}\n`);

  const { rows: [{ present }] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'attendance' AND column_name = 'deleted_by_employee_id') AS present`,
  );
  if (!present) throw new Error("Migration 007 is not applied to this database; run `npm run db:migrate` first.");

  // -------------------------------------------------------------------------
  // Seed
  // -------------------------------------------------------------------------
  const { rows: [company] } = await pool.query("SELECT id FROM companies LIMIT 1");
  if (!company) throw new Error("No companies row exists; bootstrap the database first.");

  const department = async (suffix) => {
    const { rows: [row] } = await pool.query(
      "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id", [company.id, `${tag}-${suffix}`]);
    return row.id;
  };
  const person = async (label, role, departmentId, employmentStatus = "active") => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (company_id, email, role) VALUES ($1, $2, $3) RETURNING id",
      [company.id, `${tag}-${label}@example.invalid`, role]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, employee_number, full_name, position_title, joined_on, employment_status)
       VALUES ($1, $2, $3, $4, $5, 'E2E', '2024-01-01', $6) RETURNING id`,
      [user.id, company.id, departmentId, `${tag}-${label}`, `${tag} ${label}`, employmentStatus]);
    return { userId: user.id, employeeId: employee.id, role, departmentId };
  };

  const deptA = await department("A");
  const deptB = await department("B");
  const admin = await person("admin", "admin", deptA);
  const hr = await person("hr", "hr", deptA);
  const mgrA = await person("mgrA", "manager", deptA);
  const tl = await person("tl", "tl", deptA);
  const plain = await person("employee", "employee", deptA);
  const a1 = await person("a1", "employee", deptA);
  const a2 = await person("a2", "employee", deptA);
  const b1 = await person("b1", "employee", deptB);
  const terminated = await person("term", "employee", deptA, "terminated");

  // -------------------------------------------------------------------------
  // The constraint and index names the error translation depends on exist
  // -------------------------------------------------------------------------
  const { rows: constraints } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'attendance'::regclass");
  const { rows: indexes } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'attendance'");
  const names = new Set([...constraints.map((row) => row.conname), ...indexes.map((row) => row.indexname)]);
  for (const name of [
    "attendance_employee_date_unique", "attendance_employee_id_fkey", "attendance_times_ordered",
    "attendance_absent_has_no_times", "attendance_deleted_by_requires_deleted_at",
  ]) {
    check(`constraint/index exists: ${name}`, names.has(name), `present: ${[...names].join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // HTTP: real container, repositories, services, routes; authentication stubbed
  // -------------------------------------------------------------------------
  resetContainer();
  const principals = { admin, hr, mgrA, tl, employee: plain };
  const server = createServer(createApp({ verifyAccessToken: async (token) => principals[token] }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const call = async (as, method, pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/attendance${pathname}`, {
        method,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const rowOf = async (id) => (await pool.query("SELECT * FROM attendance WHERE id = $1", [id])).rows[0];
    const showing = (value) => JSON.stringify(value);

    const D1 = "2026-09-01";
    const D2 = "2026-09-02";
    const today = todayInTimeZone(new Date(), timeZone);
    const tomorrowDate = new Date(`${today}T00:00:00Z`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrow = tomorrowDate.toISOString().slice(0, 10);

    // ---- create and read ----
    const created = await call("mgrA", "POST", "", {
      employee_id: a1.employeeId, work_date: D1, status: "present", check_in: "09:00", check_out: "17:00", notes: "e2e",
    });
    check("POST as manager (own department) -> 201", created.status === 201, showing(created));
    const id1 = created.body?.data?.id;
    check("POST response: work_date is the plain string YYYY-MM-DD", created.body?.data?.work_date === D1, showing(created.body?.data));
    check("POST response: times are HH:MM", created.body?.data?.check_in === "09:00" && created.body?.data?.check_out === "17:00", showing(created.body?.data));
    check("POST response: server-set created_at/updated_at present", created.body?.data?.created_at && created.body?.data?.updated_at, showing(created.body?.data));

    const fetched = await call("mgrA", "GET", `/${id1}`);
    check("GET by id -> 200 with the same formatted date", fetched.status === 200 && fetched.body.data.work_date === D1, showing(fetched));
    const listed = await call("admin", "GET", "");
    check("GET list includes the record", listed.body?.data?.some((row) => row.id === id1), showing(listed.body).slice(0, 200));

    // ---- duplicate day (D9) ----
    const duplicate = await call("mgrA", "POST", "", { employee_id: a1.employeeId, work_date: D1, status: "late" });
    check("POST duplicate employee/day -> 409 attendance_already_recorded", duplicate.status === 409 && duplicate.body.error.code === "attendance_already_recorded", showing(duplicate));
    check("409 carries the real existing record id", duplicate.body?.error?.details?.existing_id === id1, showing(duplicate.body?.error));

    const second = await call("mgrA", "POST", "", { employee_id: a1.employeeId, work_date: D2, status: "present" });
    const id2 = second.body?.data?.id;
    const collide = await call("mgrA", "PATCH", `/${id2}`, { work_date: D1 });
    check("PATCH moving onto an occupied day -> 409 with the occupant's id", collide.status === 409 && collide.body.error.details?.existing_id === id1, showing(collide));

    // ---- two-sided re-attribution (D27) ----
    const inB = await call("admin", "POST", "", { employee_id: b1.employeeId, work_date: D1, status: "present" });
    const id3 = inB.body?.data?.id;
    check("admin creates across departments -> 201", inB.status === 201, showing(inB));
    const pushOut = await call("mgrA", "PATCH", `/${id1}`, { employee_id: b1.employeeId });
    check("manager PUSH OUT (to another department) -> 403", pushOut.status === 403 && pushOut.body.error.code === "attendance_scope_denied", showing(pushOut));
    const pullIn = await call("mgrA", "PATCH", `/${id3}`, { employee_id: a2.employeeId });
    check("manager PULL IN (from another department) -> 403", pullIn.status === 403 && pullIn.body.error.code === "attendance_scope_denied", showing(pullIn));
    check("neither denied move changed a row", (await rowOf(id1)).employee_id === a1.employeeId && (await rowOf(id3)).employee_id === b1.employeeId, "a row changed");

    const before = await rowOf(id3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const adminMove = await call("admin", "PATCH", `/${id3}`, { employee_id: a2.employeeId });
    check("admin cross-department re-attribution -> 200", adminMove.status === 200 && adminMove.body.data.employee_id === a2.employeeId, showing(adminMove));
    const after = await rowOf(id3);
    check("updated_at advanced by the trigger; created_at unchanged", after.updated_at > before.updated_at && +after.created_at === +before.created_at, `${before.updated_at.toISOString()} -> ${after.updated_at.toISOString()}`);

    // ---- active-employee requirement (D27) ----
    const toTerminated = await call("admin", "POST", "", { employee_id: terminated.employeeId, work_date: D1, status: "present" });
    check("POST for a terminated employee -> 400 employee_not_active", toTerminated.status === 400 && toTerminated.body.error.code === "employee_not_active", showing(toTerminated));
    const reToTerminated = await call("admin", "PATCH", `/${id2}`, { employee_id: terminated.employeeId });
    check("re-attribution onto a terminated employee -> 400 employee_not_active", reToTerminated.status === 400 && reToTerminated.body.error.code === "employee_not_active", showing(reToTerminated));
    const { rows: [historical] } = await pool.query(
      "INSERT INTO attendance (employee_id, work_date, status) VALUES ($1, '2025-01-06', 'present') RETURNING id", [terminated.employeeId]);
    const editHistorical = await call("mgrA", "PATCH", `/${historical.id}`, { notes: "corrected after exit" });
    check("ordinary edit of a terminated employee's record -> 200", editHistorical.status === 200 && editHistorical.body.data.notes === "corrected after exit", showing(editHistorical));
    check("delete of a terminated employee's record -> 204", (await call("mgrA", "DELETE", `/${historical.id}`)).status === 204, "not 204");

    // ---- database CHECKs through the API ----
    const absentWithStored = await call("mgrA", "PATCH", `/${id1}`, { status: "absent" });
    check("status -> absent while stored times exist -> 400 invalid_times (CHECK translated)", absentWithStored.status === 400 && absentWithStored.body.error.code === "invalid_times", showing(absentWithStored));
    const inAfterStoredOut = await call("mgrA", "PATCH", `/${id1}`, { check_in: "18:00" });
    check("check_in later than the stored check_out -> 400 invalid_times (CHECK translated)", inAfterStoredOut.status === 400 && inAfterStoredOut.body.error.code === "invalid_times", showing(inAfterStoredOut));
    const clearBoth = await call("mgrA", "PATCH", `/${id1}`, { status: "absent", check_in: null, check_out: null });
    check("status -> absent with both times cleared in the same PATCH -> 200", clearBoth.status === 200 && clearBoth.body.data.check_in === null, showing(clearBoth));

    // ---- future date in the company timezone (D27) ----
    const future = await call("mgrA", "POST", "", { employee_id: a2.employeeId, work_date: tomorrow, status: "present" });
    check(`POST tomorrow (${tomorrow}) -> 400 work_date_in_future`, future.status === 400 && future.body.error.code === "work_date_in_future", showing(future));
    const todayRecord = await call("mgrA", "POST", "", { employee_id: a2.employeeId, work_date: today, status: "present" });
    check(`POST today in ${timeZone} (${today}) -> 201`, todayRecord.status === 201, showing(todayRecord));

    // ---- role gate ----
    for (const role of ["tl", "employee"]) {
      const denied = await call(role, "POST", "", { employee_id: a1.employeeId, work_date: "2026-09-10", status: "present" });
      check(`POST as ${role} -> 403 role_not_allowed`, denied.status === 403 && denied.body.error.code === "role_not_allowed", showing(denied));
    }
    const hrCreate = await call("hr", "POST", "", { employee_id: b1.employeeId, work_date: "2026-09-11", status: "present" });
    check("POST as hr (other department) -> 201", hrCreate.status === 201, showing(hrCreate));

    // ---- soft delete records the deleter (D27) ----
    check("DELETE as manager -> 204", (await call("mgrA", "DELETE", `/${id1}`)).status === 204, "not 204");
    const deleted = await rowOf(id1);
    check("soft delete: the row still exists with deleted_at set", deleted?.deleted_at, showing(deleted));
    check("soft delete: deleted_by_employee_id is the acting manager's employee id", deleted?.deleted_by_employee_id === mgrA.employeeId, `got ${deleted?.deleted_by_employee_id}`);
    check("a deleted record is gone from GET by id", (await call("mgrA", "GET", `/${id1}`)).status === 404, "still readable");
    check("a deleted record is gone from the list", !(await call("admin", "GET", "")).body.data.some((row) => row.id === id1), "still listed");
    check("deleting it again -> 404", (await call("mgrA", "DELETE", `/${id1}`)).status === 404, "not 404");
    check("PATCH of a deleted record -> 404", (await call("mgrA", "PATCH", `/${id1}`, { notes: "x" })).status === 404, "not 404");
    const remark = await call("mgrA", "POST", "", { employee_id: a1.employeeId, work_date: D1, status: "late", check_in: "10:00" });
    check("the freed day can be marked again (partial unique index)", remark.status === 201, showing(remark));
    const crossDelete = await call("mgrA", "DELETE", `/${hrCreate.body.data.id}`);
    check("manager deleting another department's record -> 403", crossDelete.status === 403, showing(crossDelete));

    // ---- migration 007's own constraints, in raw SQL ----
    try {
      await pool.query("UPDATE attendance SET deleted_by_employee_id = $1 WHERE id = $2", [admin.employeeId, remark.body.data.id]);
      record("CHECK rejects a deleter on a live row", false, "the update succeeded");
    } catch (error) {
      check("CHECK rejects a deleter on a live row (23514 attendance_deleted_by_requires_deleted_at)",
        error.code === "23514" && error.constraint === "attendance_deleted_by_requires_deleted_at", `${error.code} ${error.constraint}`);
    }

    const container = getContainer();
    const disposable = await person("disposable", "employee", deptA);
    const { rows: [victim] } = await pool.query(
      "INSERT INTO attendance (employee_id, work_date, status) VALUES ($1, '2025-02-03', 'present') RETURNING id", [a1.employeeId]);
    await container.attendanceRepository.deleteById(victim.id, disposable.employeeId);
    check("repository.deleteById records an arbitrary deleter", (await rowOf(victim.id)).deleted_by_employee_id === disposable.employeeId, "not recorded");
    await pool.query("DELETE FROM employees WHERE id = $1", [disposable.employeeId]);
    const orphaned = await rowOf(victim.id);
    check("hard-deleting the deleter's employee succeeds and ON DELETE SET NULL clears the pointer",
      orphaned.deleted_by_employee_id === null && orphaned.deleted_at !== null, showing(orphaned));

    // ---- foreign-key translation against the real constraint names ----
    try {
      await container.attendanceRepository.create({ employee_id: randomUUID(), work_date: "2026-09-20", status: "present" });
      record("repository.create with a nonexistent employee", false, "did not throw");
    } catch (error) {
      check("repository.create with a nonexistent employee -> 400 invalid_employee (real FK name)", error.statusCode === 400 && error.code === "invalid_employee", `${error.statusCode} ${error.code}`);
    }
    const { rows: [target] } = await pool.query(
      "INSERT INTO attendance (employee_id, work_date, status) VALUES ($1, '2025-03-03', 'present') RETURNING id", [a1.employeeId]);
    try {
      await container.attendanceRepository.deleteById(target.id, randomUUID());
      record("repository.deleteById with a nonexistent deleter", false, "did not throw");
    } catch (error) {
      check("repository.deleteById with a nonexistent deleter -> 400 invalid_reference", error.statusCode === 400 && error.code === "invalid_reference", `${error.statusCode} ${error.code}`);
    }

    // ---- time formatting ----
    const { rows: [withSeconds] } = await pool.query(
      `INSERT INTO attendance (employee_id, work_date, status, check_in, check_out)
       VALUES ($1, '2025-04-04', 'present', '09:00:30', '17:45:59') RETURNING id`, [a2.employeeId]);
    const withSecondsRead = await call("admin", "GET", `/${withSeconds.id}`);
    check("a time stored with seconds reads back as HH:MM", withSecondsRead.body?.data?.check_in === "09:00" && withSecondsRead.body?.data?.check_out === "17:45", showing(withSecondsRead.body?.data));
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
    const tag = `p6e2e-${randomUUID().slice(0, 8)}`;
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
          console.info(`cleanup done; leftover seeded users: ${leftover}`);
        } catch (error) {
          console.error(`CLEANUP FAILED -- rows tagged ${tag} may remain: ${error.message}`);
          process.exitCode = 1;
        }
      }
      await closePool();
    }
  }
}
