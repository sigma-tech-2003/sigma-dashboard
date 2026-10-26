/**
 * Fills an EMPTY, migrated database with a small sample company for the hosted demo: three departments, ten people
 * (one login each for admin, hr, manager, tl and employee), projects with KPIs, a few weeks of attendance, leave
 * requests in every state and payroll. The people are written directly; everything else goes through the real API
 * in this process, so every record passes the same validation and scope rules as one made in the app.
 *
 *   node scripts/seed-demo.js --confirm-database=neondb
 *
 * Needs the same backend/.env as the API (DATABASE_URL, AUTH_TOKEN_SECRET, COMPANY_TIMEZONE). Like every write
 * script here it requires --confirm-database and refuses NODE_ENV=production. On top of that it refuses unless the
 * database has no company and no user yet, so it can never touch real data. If it fails part-way it empties the
 * tables it filled (the database was empty when it began) and exits non-zero, so it can simply be run again.
 *
 * The five logins and their generated passwords are written to --credentials-file (default
 * backend/exports/demo-credentials.txt, which is gitignored) and are never printed. The five other colleagues get a
 * password nobody is told, so nobody can sign in as them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { getCompanyTimezone } from "../src/config/env.js";
import { closePool, getPool } from "../src/db/pool.js";
import { hashPassword } from "../src/utils/password.js";
import { buildPlan, generatePassword, todayIn } from "./demoPlan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CREDENTIALS_FILE = path.resolve(here, "../exports/demo-credentials.txt");

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
    else if (argument.startsWith("--credentials-file=")) flags.credentialsFile = path.resolve(argument.slice("--credentials-file=".length));
  }
  return flags;
}

/** Writes the company, departments, users and employees in one transaction. Returns ids keyed by person key. */
async function seedPeople(pool, plan, passwords) {
  const hashes = {};
  for (const person of plan.people) hashes[person.key] = await hashPassword(passwords[person.key]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [company] } = await client.query("INSERT INTO companies (name, code) VALUES ('Sigma Demo', 'SIGMADEMO') RETURNING id");

    const departments = {};
    for (const department of plan.departments) {
      const { rows: [row] } = await client.query(
        "INSERT INTO departments (company_id, name, description) VALUES ($1, $2, $3) RETURNING id",
        [company.id, department.name, department.description]);
      departments[department.key] = row.id;
    }

    const people = {};
    for (const person of plan.people) {
      const { rows: [user] } = await client.query(
        "INSERT INTO users (company_id, email, role, status, password_hash) VALUES ($1, $2, $3, 'active', $4) RETURNING id",
        [company.id, person.email, person.role, hashes[person.key]]);
      const { rows: [{ employee_number: employeeNumber }] } = await client.query("SELECT next_employee_number() AS employee_number");
      const { rows: [employee] } = await client.query(
        `INSERT INTO employees (user_id, company_id, department_id, team_lead_id, employee_number, full_name, position_title,
                                joined_on, employment_status, basic, allowances)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10) RETURNING id`,
        [user.id, company.id, departments[person.dept], person.lead ? people[person.lead].employeeId : null, employeeNumber,
          person.name, person.position, person.joined_on, person.basic, person.allowances]);
      people[person.key] = { userId: user.id, employeeId: employee.id, departmentId: departments[person.dept] };
    }

    for (const [deptKey, managerKey] of Object.entries(plan.departmentManagers)) {
      await client.query("UPDATE departments SET manager_employee_id = $1 WHERE id = $2", [people[managerKey].employeeId, departments[deptKey]]);
    }

    await client.query("COMMIT");
    return { departments, people };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Everything else goes through the real routes with real tokens. */
async function seedThroughApi(plan, ids, passwords) {
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const call = async (method, pathname, { token, body } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${JSON.stringify(parsed?.error ?? parsed)}`);
    return parsed?.data;
  };

  try {
    const tokens = {};
    for (const person of plan.people) {
      const session = await call("POST", "/auth/login", { body: { email: person.email, password: passwords[person.key] } });
      tokens[person.key] = session.accessToken;
    }
    const admin = tokens.admin;
    const employeeId = (key) => ids.people[key].employeeId;
    const counts = {};
    const count = (name) => { counts[name] = (counts[name] ?? 0) + 1; };

    const projectIds = {};
    for (const project of plan.projects) {
      const created = await call("POST", "/projects", { token: admin, body: {
        department_id: ids.departments[project.dept],
        team_lead_id: project.lead ? employeeId(project.lead) : null,
        title: project.title,
        description: project.description,
        start_date: project.start_date,
        due_date: project.due_date,
        status: project.status,
        assigned_employee_ids: project.assigned.map(employeeId),
      } });
      projectIds[project.key] = created.id;
      count("projects");
    }

    for (const kpi of plan.kpis) {
      const created = await call("POST", "/kpis", { token: admin, body: {
        project_id: projectIds[kpi.project], employee_id: employeeId(kpi.person), title: kpi.title,
        target: kpi.target, current_value: kpi.current, weight: kpi.weight, period: kpi.period,
      } });
      if (kpi.rating !== null) await call("POST", `/kpis/${created.id}/rating`, { token: admin, body: { rating: kpi.rating } });
      count("kpis");
    }

    for (const record of plan.attendance) {
      await call("POST", "/attendance", { token: admin, body: {
        employee_id: employeeId(record.person), work_date: record.date, status: record.status,
        check_in: record.check_in ?? null, check_out: record.check_out ?? null,
      } });
      count("attendance");
    }

    for (const leave of plan.leaves) {
      const created = await call("POST", "/leaves", { token: tokens[leave.person], body: {
        type: leave.type, start_date: leave.start_date, end_date: leave.end_date, reason: leave.reason,
      } });
      if (leave.decision) await call("PATCH", `/leaves/${created.id}`, { token: admin, body: { status: leave.decision } });
      count("leaves");
    }

    for (const row of plan.payroll) {
      await call("POST", "/payroll", { token: admin, body: {
        employee_id: employeeId(row.person), period_year: row.period_year, period_month: row.period_month,
        bonus: row.bonus, deductions: row.deductions, status: row.status,
      } });
      count("payroll");
    }
    return counts;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function credentialsText(plan, passwords, databaseName) {
  const lines = [
    "Sigma HRM demo accounts",
    `Database: ${databaseName}   Created: ${plan.today}`,
    "Keep this file private. Anyone with the site address and these passwords can sign in.",
    "",
  ];
  for (const person of plan.people.filter((entry) => entry.login)) {
    const department = plan.departments.find((entry) => entry.key === person.dept).name;
    lines.push(`${person.role.padEnd(9)} ${person.email.padEnd(30)} ${passwords[person.key]}   (${person.name}, ${person.position}, ${department})`);
  }
  lines.push("");
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));
  let pool;
  let seededFrom = null; // set once the database is known to be empty, so a failure can put it back

  try {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production.");
    pool = getPool();

    const { rows: [{ current_database: databaseName }] } = await pool.query("SELECT current_database()");
    if (!flags.confirmDatabase) throw new Error(`Refusing to seed: pass --confirm-database=${databaseName} to confirm the target.`);
    if (flags.confirmDatabase !== databaseName) throw new Error(`Refusing to seed: connected to "${databaseName}" but "${flags.confirmDatabase}" was confirmed.`);

    const { rows: [existing] } = await pool.query(`SELECT (SELECT COUNT(*) FROM companies)::int AS companies, (SELECT COUNT(*) FROM users)::int AS users`);
    if (existing.companies > 0 || existing.users > 0) {
      throw new Error(`Refusing to seed: "${databaseName}" already has ${existing.companies} company and ${existing.users} user rows. This script only fills an empty database.`);
    }
    seededFrom = "empty";

    const plan = buildPlan(todayIn(getCompanyTimezone()));
    const passwords = Object.fromEntries(plan.people.map((person) => [person.key, generatePassword()]));

    const ids = await seedPeople(pool, plan, passwords);
    const counts = await seedThroughApi(plan, ids, passwords);

    const file = flags.credentialsFile ?? DEFAULT_CREDENTIALS_FILE;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, credentialsText(plan, passwords, databaseName), { mode: 0o600 });

    console.info(`Seeded "${databaseName}": ${plan.people.length} people in ${plan.departments.length} departments.`);
    console.info(Object.entries(counts).map(([name, total]) => `  ${name}: ${total}`).join("\n"));
    console.info(`\nThe five logins and their passwords are in ${file}`);
  } catch (error) {
    console.error(error.message);
    if (seededFrom === "empty" && pool) {
      // The database held no company and no user when this began, so emptying it restores that state.
      await pool.query("TRUNCATE companies CASCADE").then(
        () => console.error("Seeding failed part-way; the tables it filled were emptied, so it is safe to run again."),
        (cleanupError) => console.error(`Seeding failed part-way AND emptying the tables failed: ${cleanupError.message}`),
      );
    }
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
