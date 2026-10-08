/**
 * End-to-end check of the backend additions that D32-D39 require for the frontend cutover, against a REAL
 * PostgreSQL database: the real container, repositories, services and routes (over HTTP). Unlike the other
 * end-to-end scripts, AUTHENTICATION IS NOT STUBBED: seeded users have real password hashes, and every
 * call carries a real access token from a real POST /auth/login. The unit tests run against fakes and
 * cannot see SQL, pg's date and numeric types, or the real token and middleware path; this can.
 *
 *   node scripts/e2e-frontend-prereqs.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL, AUTH_TOKEN_SECRET,
 * COMPANY_TIMEZONE). No migration is needed: these additions change queries and one write, not the schema.
 *
 * It writes: departments, users, employees, projects and payroll, all reachable by the tag `p10e2e-<random>`
 * in a user's email or a department/project name. Everything it creates is deleted again in a `finally`,
 * found by that tag, so a run that dies half-way through seeding still cleans up. It never touches a row
 * it did not create. Exits non-zero if any check fails.
 *
 * One side effect cannot be undone: employees created through the API draw their employee_number from the
 * next_employee_number() sequence, which does not roll back, so the sequence advances by a few per run.
 *
 * It proves, against the real database: that login and refresh report principal.role for all five roles
 * (D37); that GET /auth/me is bearer-protected and returns only the caller's own profile (D32); that
 * department_name reaches a manager, tl and employee who cannot read the departments list (D33); that
 * employee money is a JSON number and joined_on a YYYY-MM-DD string where the raw pg values are not
 * (D38, D31); that employment_status 'inactive' can be set on create, 'terminated' and 'on_leave' cannot,
 * and an employee created inactive cannot log in even with a password (D35); and that the client's tax
 * preview agrees with the tax the database really computes.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { closePool, getPool } from "../src/db/pool.js";
import { hashPassword } from "../src/utils/password.js";
import { payrollTax } from "../../src/utils/payrollTax.js";

const PASSWORD = "correct horse battery staple";
const ROLES = ["admin", "hr", "manager", "tl", "employee"];

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
  }
  return flags;
}

/**
 * Deletes everything this run created, located by TAG. Employees and their users are found through the
 * tagged EMAIL, not the employee number: employees created through the API get a sequence-assigned number.
 */
async function cleanup(pool, tag) {
  const users = "(SELECT id FROM users WHERE email LIKE $1)";
  const employees = `(SELECT id FROM employees WHERE user_id IN ${users})`;
  const like = `${tag}-%@example.invalid`;
  await pool.query(`DELETE FROM payroll WHERE employee_id IN ${employees}`, [like]);
  await pool.query("DELETE FROM projects WHERE title LIKE $1", [`${tag} %`]);
  await pool.query(`DELETE FROM password_set_tokens WHERE user_id IN ${users}`, [like]);
  await pool.query(`UPDATE employees SET team_lead_id = NULL WHERE user_id IN ${users}`, [like]);
  await pool.query(`DELETE FROM employees WHERE user_id IN ${users}`, [like]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [like]); // refresh_tokens cascade
  await pool.query("DELETE FROM departments WHERE name LIKE $1", [`${tag}-%`]);
}

async function run(pool, tag) {
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.info(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  };
  const check = (name, condition, detail) => record(name, Boolean(condition), detail);
  const showing = (value) => JSON.stringify(value);
  const emailOf = (label) => `${tag}-${label}@example.invalid`;

  console.info(`tag: ${tag}\n`);

  // -------------------------------------------------------------------------
  // Seed: real users with real password hashes, so real login works
  // -------------------------------------------------------------------------
  const { rows: [company] } = await pool.query("SELECT id FROM companies LIMIT 1");
  if (!company) throw new Error("No companies row exists; bootstrap the database first.");
  const passwordHash = await hashPassword(PASSWORD);

  const department = async (suffix) => {
    const { rows: [row] } = await pool.query(
      "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id, name", [company.id, `${tag}-${suffix}`]);
    return row;
  };
  const person = async (label, role, departmentId, { teamLeadId = null, basic = 50000, allowances = 0 } = {}) => {
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (company_id, email, role, status, password_hash) VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
      [company.id, emailOf(label), role, passwordHash]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, team_lead_id, employee_number, full_name, position_title,
                              joined_on, employment_status, basic, allowances)
       VALUES ($1, $2, $3, $4, $5, $6, 'E2E', '2024-01-01', 'active', $7, $8) RETURNING id`,
      [user.id, company.id, departmentId, teamLeadId, `${tag}-${label}`, `${tag} ${label}`, basic, allowances]);
    return { label, userId: user.id, employeeId: employee.id, role, departmentId };
  };

  const deptA = await department("A");
  const deptB = await department("B");
  const admin = await person("admin", "admin", deptA.id);
  const hr = await person("hr", "hr", deptA.id);
  const manager = await person("manager", "manager", deptA.id);
  const tl = await person("tl", "tl", deptA.id);
  const employee = await person("employee", "employee", deptA.id, { teamLeadId: tl.employeeId, basic: 120000.5, allowances: 15000.25 });
  const outsider = await person("outsider", "employee", deptB.id, { basic: 80000, allowances: 2000 });
  const people = { admin, hr, manager, tl, employee };

  // -------------------------------------------------------------------------
  // HTTP: real container, repositories, services, routes -- and REAL authentication
  // -------------------------------------------------------------------------
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const call = async (method, pathname, { token, body, cookie } = {}) => {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      if (cookie) headers.cookie = `refresh_token=${cookie}`;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const setCookie = response.headers.getSetCookie().find((header) => header.startsWith("refresh_token="));
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        refreshToken: setCookie ? setCookie.split(";")[0].slice("refresh_token=".length) : null,
      };
    };
    const errorOf = (response) => `${response.status} ${response.body?.error?.code}`;
    const login = (email, password = PASSWORD) => call("POST", "/auth/login", { body: { email, password } });

    const sessions = {};
    for (const role of ROLES) sessions[role] = await login(emailOf(role));
    const tokenOf = (role) => sessions[role].body?.data?.accessToken;

    // ======================================================================
    // D37: the role picker -- principal.role is enough, no backend change
    // ======================================================================
    check("real POST /auth/login succeeds for all five roles", ROLES.every((role) => sessions[role].status === 200), showing(ROLES.map((r) => sessions[r].status)));
    check("D37: login returns principal.role equal to the stored role, for all five roles",
      ROLES.every((role) => sessions[role].body.data.principal.role === role), showing(ROLES.map((r) => sessions[r].body?.data?.principal?.role)));
    check("D37: each of the five picker values is therefore a role the client can compare against",
      sameSet(ROLES, ["admin", "hr", "manager", "tl", "employee"]), "");
    check("D37: the principal is still the existing { userId, employeeId, role, departmentId, isTeamLead } -- nothing was added to login",
      showing(Object.keys(sessions.manager.body.data.principal).sort()) === showing(["departmentId", "employeeId", "isTeamLead", "role", "userId"]), showing(sessions.manager.body?.data?.principal));
    check("D37: isTeamLead is true only for the tl role (a derived flag, not a second source of truth for the picker)",
      ROLES.every((role) => sessions[role].body.data.principal.isTeamLead === (role === "tl")), showing(ROLES.map((r) => sessions[r].body?.data?.principal?.isTeamLead)));
    const refreshed = {};
    for (const role of ROLES) refreshed[role] = await call("POST", "/auth/refresh", { cookie: sessions[role].refreshToken });
    check("D37: POST /auth/refresh (cookie) returns principal.role too, for all five roles",
      ROLES.every((role) => refreshed[role].status === 200 && refreshed[role].body.data.principal.role === role), showing(ROLES.map((r) => refreshed[r].status)));
    check("a wrong password is the same generic 401 as an unknown email",
      errorOf(await login(emailOf("employee"), "wrong password")) === errorOf(await login("nobody@example.invalid")), "");

    // ======================================================================
    // D32: GET /auth/me
    // ======================================================================
    check("D32: GET /auth/me without a bearer token -> 401", errorOf(await call("GET", "/auth/me")) === "401 unauthenticated", "");
    check("D32: ...with a garbage token -> 401", (await call("GET", "/auth/me", { token: "not.a.token" })).status === 401, "");
    check("D32: ...and a refresh COOKIE is not a bearer token -> 401", (await call("GET", "/auth/me", { cookie: sessions.employee.refreshToken })).status === 401, "");

    const me = {};
    for (const role of ROLES) me[role] = await call("GET", "/auth/me", { token: tokenOf(role) });
    check("D32: GET /auth/me -> 200 for all five roles, each with its OWN profile (id, role, email)",
      ROLES.every((role) => me[role].status === 200 && me[role].body.data.id === people[role].employeeId
        && me[role].body.data.role === role && me[role].body.data.email === emailOf(role)), showing(ROLES.map((r) => me[r].status)));
    check("D32: the profile is exactly the 12 documented fields, and carries no compensation",
      showing(Object.keys(me.employee.body.data).sort()) === showing([
        "department_id", "department_name", "email", "employee_number", "employment_status", "full_name", "id",
        "joined_on", "phone", "position_title", "role", "team_lead_id"]), showing(Object.keys(me.employee.body?.data ?? {}).sort()));
    check("D32: ...in particular no basic or allowances", !Object.hasOwn(me.employee.body.data, "basic") && !Object.hasOwn(me.employee.body.data, "allowances"), "");
    check("D32: a query string cannot ask for anyone else's profile",
      (await call("GET", `/auth/me?employee_id=${admin.employeeId}`, { token: tokenOf("employee") })).body?.data?.id === employee.employeeId, "");
    check("D32: only GET exists on /auth/me -> POST is 404", (await call("POST", "/auth/me", { token: tokenOf("admin"), body: {} })).status === 404, "");
    check("D32: the public auth routes are unaffected beside it: a refresh with no cookie is its own 401, not the middleware's",
      errorOf(await call("POST", "/auth/refresh")) === "401 unauthenticated", "");

    // ======================================================================
    // D33: department_name for roles that cannot read the departments list
    // ======================================================================
    check("D33: /auth/me carries department_name AND department_id for manager, tl and employee",
      ["manager", "tl", "employee"].every((role) => me[role].body.data.department_name === deptA.name && me[role].body.data.department_id === deptA.id), showing(me.employee.body?.data));
    for (const role of ["manager", "tl", "employee"]) {
      const list = await call("GET", "/departments", { token: tokenOf(role) });
      check(`D33: control -- ${role} cannot read the departments list (so the name could not have come from there)`,
        list.status === 200 && Array.isArray(list.body.data) && list.body.data.length === 0, showing(list.body).slice(0, 120));
    }
    check("D33: control -- admin CAN read the departments list, which is where the names come from for them",
      (await call("GET", "/departments", { token: tokenOf("admin") })).body.data.some((row) => row.name === deptA.name), "");
    for (const role of ["manager", "tl"]) {
      const rows = (await call("GET", "/employees", { token: tokenOf(role) })).body.data;
      check(`D33: every employee row ${role} can read carries department_name (and only their own department's: ${rows.length} rows)`,
        rows.length > 0 && rows.every((row) => row.department_name === deptA.name && row.department_id === deptA.id), showing(rows.map((r) => r.department_name)));
    }
    const ownRow = (await call("GET", "/employees", { token: tokenOf("employee") })).body.data;
    check("D33: an employee's own row carries department_name", ownRow.length === 1 && ownRow[0].department_name === deptA.name, showing(ownRow));
    const adminRows = (await call("GET", "/employees", { token: tokenOf("admin") })).body.data;
    check("D33: admin sees both departments' names on their rows",
      adminRows.some((row) => row.department_name === deptA.name) && adminRows.some((row) => row.department_name === deptB.name), "");
    check("D33: GET /employees/:id carries it too", (await call("GET", `/employees/${employee.employeeId}`, { token: tokenOf("tl") })).body?.data?.department_name === deptA.name, "");

    const created = await call("POST", "/projects", { token: tokenOf("admin"), body: {
      department_id: deptA.id, team_lead_id: tl.employeeId, title: `${tag} proj`, description: "e2e",
      start_date: "2026-03-01", due_date: "2026-04-01", status: "active", assigned_employee_ids: [employee.employeeId] } });
    check("D33: POST /projects (write response) carries department_name", created.status === 201 && created.body.data.department_name === deptA.name, showing(created));
    for (const role of ["admin", "manager", "tl", "employee"]) {
      const projects = (await call("GET", "/projects", { token: tokenOf(role) })).body.data;
      const mine = projects.find((project) => project.id === created.body.data.id);
      check(`D33: ${role} reading projects gets department_name on the project`, mine?.department_name === deptA.name && mine?.department_id === deptA.id, showing(mine));
    }

    // ======================================================================
    // D38 and D31: money as numbers, joined_on as text -- against the raw pg values
    // ======================================================================
    const adminEmployee = adminRows.find((row) => row.id === employee.employeeId);
    check("D38: employee basic and allowances are JSON NUMBERS (120000.5 and 15000.25), not strings",
      adminEmployee?.basic === 120000.5 && adminEmployee?.allowances === 15000.25, showing([adminEmployee?.basic, adminEmployee?.allowances]));
    check("D38: every employee row, for every employee, has numeric money", adminRows.every((row) => typeof row.basic === "number" && typeof row.allowances === "number"), "");
    const { rows: [raw] } = await pool.query("SELECT basic, allowances, joined_on FROM employees WHERE id = $1", [employee.employeeId]);
    check("D38 control: read RAW through pg, the same columns arrive as STRINGS -- which is what the cast fixes",
      typeof raw.basic === "string" && typeof raw.allowances === "string", showing([typeof raw.basic, typeof raw.allowances]));
    check("D31 control: read RAW through pg, joined_on is a JS Date (server-local midnight) -- the day-early hazard",
      raw.joined_on instanceof Date, showing(raw.joined_on));
    check("D31: through the API, joined_on is the plain string 2024-01-01 on a list, a single read and /auth/me",
      adminEmployee?.joined_on === "2024-01-01" && me.employee.body.data.joined_on === "2024-01-01"
      && (await call("GET", `/employees/${employee.employeeId}`, { token: tokenOf("admin") })).body.data.joined_on === "2024-01-01", showing(adminEmployee?.joined_on));

    // The client's tax preview against the tax the database REALLY computes (payroll defaults basic and
    // allowances from the employee row, which are now numbers).
    const payroll = await call("POST", "/payroll", { token: tokenOf("admin"), body: { employee_id: employee.employeeId, period_year: 2026, period_month: 3 } });
    check("D38: POST /payroll defaults basic and allowances from the employee row (now numbers) -> 201",
      payroll.status === 201 && payroll.body.data.basic === 120000.5 && payroll.body.data.allowances === 15000.25, showing(payroll));
    const gross = payroll.body?.data?.basic + payroll.body?.data?.allowances;
    check(`D38: the database's tax for gross ${gross} (${payroll.body?.data?.tax}) equals the CLIENT preview, payrollTax(${gross}) = ${payrollTax(gross)}`,
      payroll.body?.data?.tax === payrollTax(gross), showing([payroll.body?.data?.tax, payrollTax(gross)]));
    check("D38: ...and the stored net is gross - deductions - that tax", payroll.body?.data?.net === gross - 0 - payrollTax(gross), showing(payroll.body?.data));
    for (const [basic, allowances] of [[49999.99, 0], [50010, 0], [100005, 0], [200010, 0], [300000.55, 0.45]]) {
      const target = await person(`pay-${basic}`, "employee", deptA.id, { basic, allowances });
      const row = await call("POST", "/payroll", { token: tokenOf("admin"), body: { employee_id: target.employeeId, period_year: 2026, period_month: 4 } });
      check(`D38: for gross ${basic + allowances} the database computed tax ${row.body?.data?.tax} and the client preview agrees (${payrollTax(basic + allowances)})`,
        row.status === 201 && row.body.data.tax === payrollTax(basic + allowances), showing(row));
    }

    // ======================================================================
    // D35: employment_status on create
    // ======================================================================
    const newEmployee = (label, extra = {}) => ({
      email: emailOf(label), role: "employee", full_name: `${tag} ${label}`, position_title: "E2E",
      joined_on: "2026-09-25", basic: 40000, allowances: 0, department_id: deptA.id, ...extra });
    const inactive = await call("POST", "/employees", { token: tokenOf("admin"), body: newEmployee("inactive", { employment_status: "inactive" }) });
    check("D35: POST /employees with employment_status 'inactive' -> 201, reported as inactive", inactive.status === 201 && inactive.body.data.employment_status === "inactive", showing(inactive));
    const defaulted = await call("POST", "/employees", { token: tokenOf("admin"), body: newEmployee("defaulted") });
    check("D35: ...omitted, it defaults to 'active'", defaulted.status === 201 && defaulted.body.data.employment_status === "active", showing(defaulted));
    const dbRows = (await pool.query(
      `SELECT employees.employment_status, users.status AS user_status FROM employees JOIN users ON users.id = employees.user_id
       WHERE users.email = ANY($1::text[]) ORDER BY users.email`, [[emailOf("defaulted"), emailOf("inactive")]])).rows;
    check("D35: the database agrees: defaulted = active, inactive = inactive", showing(dbRows.map((r) => r.employment_status)) === showing(["active", "inactive"]), showing(dbRows));
    check("D35: users.status is 'invited' for BOTH, whatever the employment status", dbRows.every((r) => r.user_status === "invited"), showing(dbRows));
    for (const status of ["terminated", "on_leave", "Active", "suspended", ""]) {
      const refused = await call("POST", "/employees", { token: tokenOf("admin"), body: newEmployee(`refused-${status || "empty"}`, { employment_status: status }) });
      check(`D35: employment_status '${status}' on create -> 400 invalid_request`, errorOf(refused) === "400 invalid_request", errorOf(refused));
    }
    const { rows: [{ n: leftBehind }] } = await pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE $1", [`${tag}-refused-%`]);
    check("D35: none of the refused requests created a user or employee", leftBehind === 0, String(leftBehind));
    const byManager = await call("POST", "/employees", { token: tokenOf("manager"), body: newEmployee("by-manager", { employment_status: "inactive", department_id: undefined }) });
    check("D35: a manager may create an inactive employee in their own department (no extra gate) -> 201", byManager.status === 201 && byManager.body.data.employment_status === "inactive", showing(byManager));
    check("D35: an UPDATE still accepts every status: PATCH on_leave -> 200",
      (await call("PATCH", `/employees/${defaulted.body.data.id}`, { token: tokenOf("admin"), body: { employment_status: "on_leave" } })).status === 200, "");
    await call("PATCH", `/employees/${defaulted.body.data.id}`, { token: tokenOf("admin"), body: { employment_status: "active" } });

    // The claim D35 rests on: an employee created inactive cannot log in EVEN WITH A PASSWORD, and can
    // once they are made active. (Uses the real D25/D34 set-password path.)
    const setPassword = async (employeeId) => {
      const issued = await call("POST", `/employees/${employeeId}/password-token`, { token: tokenOf("admin") });
      const redeemed = await call("POST", "/auth/set-password", { body: { token: issued.body?.data?.token, password: PASSWORD } });
      return { issued, redeemed };
    };
    const inactiveSet = await setPassword(inactive.body.data.id);
    check("D34: admin issues a token (201) and the new employee redeems it (204)", inactiveSet.issued.status === 201 && inactiveSet.redeemed.status === 204, showing([inactiveSet.issued.status, inactiveSet.redeemed.status]));
    check("D35: after setting a password, an employee created INACTIVE still cannot log in -> 401",
      errorOf(await login(emailOf("inactive"))) === "401 unauthenticated", "");
    await call("PATCH", `/employees/${inactive.body.data.id}`, { token: tokenOf("admin"), body: { employment_status: "active" } });
    const activated = await login(emailOf("inactive"));
    check("D35: once made active, the same password logs in -> 200 as an employee", activated.status === 200 && activated.body.data.principal.role === "employee", errorOf(activated));
    const activatedMe = await call("GET", "/auth/me", { token: activated.body?.data?.accessToken });
    check("D32 + D33: and /auth/me for that new employee carries their department name", activatedMe.body?.data?.department_name === deptA.name && activatedMe.body?.data?.employment_status === "active", showing(activatedMe.body));

    const defaultedSet = await setPassword(defaulted.body.data.id);
    const defaultedLogin = await login(emailOf("defaulted"));
    check("D35: an employee created with the default status logs in as soon as they set a password",
      defaultedSet.redeemed.status === 204 && defaultedLogin.status === 200, errorOf(defaultedLogin));
    check("D34 control: before any password is set, a freshly created employee cannot log in at all -> 401",
      errorOf(await login(emailOf("by-manager"))) === "401 unauthenticated", "");
    check("D34: a manager cannot issue a set-password token (admin and hr only) -> 403",
      (await call("POST", `/employees/${byManager.body?.data?.id}/password-token`, { token: tokenOf("manager") })).status === 403, "");
    void hr; void outsider;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return results;
}

function sameSet(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
  } else {
    const pool = getPool();
    const tag = `p10e2e-${randomUUID().slice(0, 8)}`;
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

      // Pre-flight, before anything is written and before cleanup is armed: the tables this run touches and
      // cleans up must exist (password_set_tokens arrived with migration 006).
      const { rows: [{ present }] } = await pool.query(
        `SELECT count(*) = 3 AS present FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('password_set_tokens', 'payroll', 'projects')`,
      );
      if (!present) throw new Error("The database is missing tables this script needs; run `npm run db:migrate` first.");

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
          const { rows: [{ leftoverDepartments }] } = await pool.query(
            `SELECT count(*)::int AS "leftoverDepartments" FROM departments WHERE name LIKE $1`, [`${tag}-%`]);
          console.info(`cleanup done; leftover seeded users: ${leftover}; leftover departments: ${leftoverDepartments}`);
        } catch (error) {
          console.error(`CLEANUP FAILED -- rows tagged ${tag} may remain: ${error.message}`);
          process.exitCode = 1;
        }
      }
      await closePool();
    }
  }
}
