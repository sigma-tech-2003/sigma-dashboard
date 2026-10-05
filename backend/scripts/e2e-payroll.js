/**
 * End-to-end check of the Phase 7 payroll write endpoints against a REAL PostgreSQL database:
 * the real container, repositories, services and routes (over HTTP), with only authentication
 * stubbed. The unit tests run against fakes and cannot see SQL, constraint names, generated
 * columns, triggers, partial indexes or pg's number types; this can.
 *
 *   node scripts/e2e-payroll.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL,
 * AUTH_TOKEN_SECRET, COMPANY_TIMEZONE), and migration 008 already applied (`npm run db:migrate`).
 *
 * It writes: departments, users, employees and payroll rows, all tagged `p7e2e-<random>`.
 * Everything it creates is deleted again in a `finally`, found by that tag rather than by
 * remembered ids, so a run that dies half-way through seeding still cleans up. It never touches a
 * row it did not create. Exits non-zero if any check fails.
 *
 * Among other things it verifies the constraint names payrollRepository.js's error translation
 * assumes -- in particular the auto-named foreign key payroll_employee_id_fkey -- against the
 * names Postgres actually generated.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { getCompanyTimezone } from "../src/config/env.js";
import { getContainer, resetContainer } from "../src/container.js";
import { closePool, getPool } from "../src/db/pool.js";

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
    `DELETE FROM payroll
     WHERE employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)
        OR deleted_by_employee_id IN (SELECT id FROM employees WHERE employee_number LIKE $1)`,
    [like],
  );
  await pool.query("DELETE FROM employees WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}-%@example.invalid`]);
  await pool.query("DELETE FROM departments WHERE name LIKE $1", [like]);
}

const MONEY = ["basic", "allowances", "bonus", "deductions", "gross", "tax", "net"];
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

async function run(pool, tag) {
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.info(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  };
  const check = (name, condition, detail) => record(name, Boolean(condition), detail);
  const showing = (value) => JSON.stringify(value);

  console.info(`tag: ${tag}   timezone: ${getCompanyTimezone()}\n`);

  // -------------------------------------------------------------------------
  // Seed
  // -------------------------------------------------------------------------
  const { rows: [company] } = await pool.query("SELECT id FROM companies LIMIT 1");
  if (!company) throw new Error("No companies row exists; bootstrap the database first.");

  const { rows: [dept] } = await pool.query(
    "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id", [company.id, `${tag}-dept`]);
  const person = async (label, role, { basic = 0, allowances = 0, employmentStatus = "active" } = {}) => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (company_id, email, role) VALUES ($1, $2, $3) RETURNING id",
      [company.id, `${tag}-${label}@example.invalid`, role]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, employee_number, full_name, position_title,
                              joined_on, employment_status, basic, allowances)
       VALUES ($1, $2, $3, $4, $5, 'E2E', '2024-01-01', $6, $7, $8) RETURNING id`,
      [user.id, company.id, dept.id, `${tag}-${label}`, `${tag} ${label}`, employmentStatus, basic, allowances]);
    return { userId: user.id, employeeId: employee.id, role, departmentId: dept.id };
  };

  const admin = await person("admin", "admin");
  const hr = await person("hr", "hr");
  const manager = await person("manager", "manager");
  const tl = await person("tl", "tl");
  const e1 = await person("e1", "employee", { basic: 50000, allowances: 5000 });
  const e2 = await person("e2", "employee", { basic: 70000, allowances: 0 });
  const leaver = await person("leaver", "employee", { basic: 40000, allowances: 2500, employmentStatus: "terminated" });

  // -------------------------------------------------------------------------
  // The constraint and index names the error translation depends on, against what Postgres
  // actually generated. The employee_id foreign key is auto-named, so its name was an assumption.
  // -------------------------------------------------------------------------
  const { rows: foreignKeys } = await pool.query(
    `SELECT c.conname, a.attname AS column_name
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'payroll'::regclass AND c.contype = 'f'`);
  console.info(`payroll foreign keys as generated: ${foreignKeys.map((fk) => `${fk.column_name} -> ${fk.conname}`).join(", ")}`);
  const fkNameFor = (column) => foreignKeys.find((fk) => fk.column_name === column)?.conname;
  check("FK on employee_id is named payroll_employee_id_fkey (the name the translator assumes)",
    fkNameFor("employee_id") === "payroll_employee_id_fkey", `actual: ${fkNameFor("employee_id")}`);
  check("FK on deleted_by_employee_id is named payroll_deleted_by_employee_id_fkey, distinct from the employee one",
    fkNameFor("deleted_by_employee_id") === "payroll_deleted_by_employee_id_fkey", `actual: ${fkNameFor("deleted_by_employee_id")}`);

  const { rows: constraints } = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'payroll'::regclass");
  const { rows: indexes } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'payroll'");
  const names = new Set([...constraints.map((row) => row.conname), ...indexes.map((row) => row.indexname)]);
  for (const name of [
    "payroll_employee_period_unique", "payroll_year_range", "payroll_month_range",
    "payroll_amounts_non_negative", "payroll_deleted_by_requires_deleted_at", "payroll_deleted_by_index",
  ]) {
    check(`constraint/index exists: ${name}`, names.has(name), `present: ${[...names].join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // HTTP: real container, repositories, services, routes; authentication stubbed
  // -------------------------------------------------------------------------
  resetContainer();
  const principals = { admin, hr, manager, tl, employee: e1 };
  const server = createServer(createApp({ verifyAccessToken: async (token) => principals[token] }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const call = async (as, method, pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/payroll${pathname}`, {
        method,
        headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const rowOf = async (id) => (await pool.query("SELECT * FROM payroll WHERE id = $1", [id])).rows[0];
    const container = getContainer();

    // ---- create: defaults from the employee, amounts as JSON numbers ----
    const created = await call("admin", "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 9 });
    check("POST as admin with basic/allowances omitted -> 201", created.status === 201, showing(created));
    const first = created.body?.data;
    const id1 = first?.id;
    check("basic and allowances defaulted from the employee (50000 / 5000)", near(first?.basic, 50000) && near(first?.allowances, 5000), showing(first));
    check("bonus and deductions default to 0; status defaults to processed", first?.bonus === 0 && first?.deductions === 0 && first?.status === "processed", showing(first));
    check("D28: all seven money fields are JSON numbers, not strings",
      MONEY.every((key) => typeof first?.[key] === "number"), showing(MONEY.map((key) => `${key}:${typeof first?.[key]}`)));
    check("gross, tax and net are computed by the database (55000 / 250 / 54750)", near(first?.gross, 55000) && near(first?.tax, 250) && near(first?.net, 54750), showing(first));
    check("created_at and updated_at are server-set", first?.created_at && first?.updated_at, showing(first));
    const rawControl = (await pool.query("SELECT basic, net FROM payroll WHERE id = $1", [id1])).rows[0];
    check("control: a raw numeric column really does come back from pg as a string, so the cast matters",
      typeof rawControl?.basic === "string" && typeof rawControl?.net === "string", showing(rawControl));

    const fetched = await call("admin", "GET", `/${id1}`);
    check("GET by id returns numbers for every money field too", fetched.status === 200 && MONEY.every((key) => typeof fetched.body.data[key] === "number"), showing(fetched));
    const listed = await call("hr", "GET", "");
    check("GET list returns numbers for every money field", listed.body?.data?.length > 0 && listed.body.data.every((row) => MONEY.every((key) => typeof row[key] === "number")), showing(listed.body).slice(0, 200));

    // ---- explicit overrides, decimals, and the tax brackets ----
    const override = await call("admin", "POST", "", {
      employee_id: e2.employeeId, period_year: 2026, period_month: 1, basic: 42000.55, allowances: 0, bonus: 100, deductions: 20.25,
    });
    check("explicit basic/allowances win over the employee's, and an explicit 0 stays 0", override.status === 201 && near(override.body.data.basic, 42000.55) && override.body.data.allowances === 0, showing(override));
    check("two-decimal amounts round-trip exactly; net = gross - deductions - tax", near(override.body.data.gross, 42100.55) && near(override.body.data.tax, 0) && near(override.body.data.net, 42080.3), showing(override.body?.data));

    for (const [month, gross, tax] of [[2, 50000, 0], [3, 100000, 2500], [4, 150000, 7500], [5, 250000, 20000]]) {
      const bracket = await call("admin", "POST", "", { employee_id: e2.employeeId, period_year: 2025, period_month: month, basic: gross, allowances: 0 });
      check(`tax bracket: gross ${gross} -> tax ${tax}`, bracket.status === 201 && near(bracket.body.data.tax, tax) && near(bracket.body.data.net, gross - tax), showing(bracket));
    }

    check("D7: generated columns cannot be written, even by raw SQL", await (async () => {
      try { await pool.query("UPDATE payroll SET tax = 1 WHERE id = $1", [id1]); return false; } catch (error) { return error.code === "428C9"; }
    })(), "the update succeeded or failed differently");
    const withTax = await call("admin", "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 2, tax: 5 });
    check("a client-supplied tax is a 400", withTax.status === 400, showing(withTax));

    // ---- eligibility ----
    const finalPay = await call("hr", "POST", "", { employee_id: leaver.employeeId, period_year: 2026, period_month: 9 });
    check("a terminated employee is accepted, with their basic/allowances defaulted (final pay)", finalPay.status === 201 && near(finalPay.body.data.basic, 40000) && near(finalPay.body.data.allowances, 2500), showing(finalPay));
    const unknown = await call("admin", "POST", "", { employee_id: randomUUID(), period_year: 2026, period_month: 9 });
    check("an unknown employee -> 400 invalid_employee", unknown.status === 400 && unknown.body.error.code === "invalid_employee", showing(unknown));

    // ---- role gate ----
    for (const role of ["manager", "tl", "employee"]) {
      const denied = await call(role, "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 3 });
      check(`POST as ${role} -> 403 role_not_allowed`, denied.status === 403 && denied.body.error.code === "role_not_allowed", showing(denied));
    }

    // ---- duplicate period (D28, mirroring D9) ----
    const duplicate = await call("hr", "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 9, bonus: 1 });
    check("POST duplicate employee/period -> 409 payroll_already_recorded", duplicate.status === 409 && duplicate.body.error.code === "payroll_already_recorded", showing(duplicate));
    check("409 carries the real existing record id", duplicate.body?.error?.details?.existing_id === id1, showing(duplicate.body?.error));

    // ---- draft lifecycle ----
    const draft = await call("admin", "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 10, status: "draft", bonus: 100 });
    const draftId = draft.body?.data?.id;
    check("POST status=draft -> 201, stored as a draft", draft.status === 201 && draft.body.data.status === "draft", showing(draft));
    const employeeListBefore = await call("employee", "GET", "");
    check("an employee does not see a draft of their own", employeeListBefore.status === 200 && !employeeListBefore.body.data.some((row) => row.id === draftId), showing(employeeListBefore.body).slice(0, 200));
    check("an employee does see their own processed record, with numeric amounts", employeeListBefore.body?.data?.some((row) => row.id === id1 && typeof row.net === "number"), showing(employeeListBefore.body).slice(0, 200));

    const collide = await call("admin", "PATCH", `/${draftId}`, { period_month: 9 });
    check("PATCH moving a draft onto an occupied period -> 409 with the occupant's id", collide.status === 409 && collide.body.error.details?.existing_id === id1, showing(collide));

    const beforeEdit = await rowOf(draftId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const edited = await call("admin", "PATCH", `/${draftId}`, { basic: 60000, bonus: 500, deductions: 50 });
    // The draft kept the employee's defaulted allowances of 5000, so gross = 60000 + 5000 + 500.
    // tax = (65500 - 50000) * 5% = 775; net = 65500 - 50 - 775.
    check("PATCH a draft's fields -> 200 with recomputed gross/tax/net", edited.status === 200 && near(edited.body.data.gross, 65500) && near(edited.body.data.tax, 775) && near(edited.body.data.net, 64675), showing(edited));
    const afterEdit = await rowOf(draftId);
    check("updated_at advanced by the trigger; created_at unchanged", afterEdit.updated_at > beforeEdit.updated_at && +afterEdit.created_at === +beforeEdit.created_at, "timestamps");

    const promoted = await call("hr", "PATCH", `/${draftId}`, { bonus: 700, status: "processed" });
    check("PATCH a draft: edit and promote together -> 200, now processed", promoted.status === 200 && promoted.body.data.status === "processed" && near(promoted.body.data.bonus, 700), showing(promoted));
    const employeeListAfter = await call("employee", "GET", "");
    check("once processed, the employee sees it", employeeListAfter.body?.data?.some((row) => row.id === draftId), showing(employeeListAfter.body).slice(0, 200));

    // ---- processed records are immutable ----
    const snapshot = await rowOf(draftId);
    for (const body of [{ bonus: 1 }, { status: "draft" }, { status: "processed" }, { employee_id: e2.employeeId }]) {
      const refused = await call("admin", "PATCH", `/${draftId}`, body);
      check(`PATCH of a processed record ${showing(body)} -> 409 payroll_not_editable`, refused.status === 409 && refused.body.error.code === "payroll_not_editable", showing(refused));
    }
    const unchanged = await rowOf(draftId);
    check("the refused PATCHes changed nothing", unchanged.status === "processed" && unchanged.bonus === snapshot.bonus && +unchanged.updated_at === +snapshot.updated_at, showing(unchanged));

    // ---- the repository's own status guard, bypassing the service's earlier check ----
    const { rows: [raceTarget] } = await pool.query(
      `INSERT INTO payroll (employee_id, period_year, period_month, basic, status)
       VALUES ($1, 2024, 6, 1000, 'draft') RETURNING id`, [e1.employeeId]);
    await pool.query("UPDATE payroll SET status = 'processed' WHERE id = $1", [raceTarget.id]); // promoted "by someone else"
    try {
      await container.payrollRepository.updateById(raceTarget.id, { bonus: 5 });
      record("repository.updateById on a processed record", false, "did not throw");
    } catch (error) {
      check("repository.updateById on a processed record -> 409 payroll_not_editable (the SQL guard, no service involved)", error.statusCode === 409 && error.code === "payroll_not_editable", `${error.statusCode} ${error.code}`);
    }
    check("...and the guarded UPDATE changed nothing", Number((await rowOf(raceTarget.id)).bonus) === 0, showing(await rowOf(raceTarget.id)));
    check("repository.updateById on a record that does not exist -> null", (await container.payrollRepository.updateById(randomUUID(), { bonus: 5 })) === null, "not null");

    // ---- database CHECKs and overflow, through the real constraint names ----
    const base = { employee_id: e1.employeeId, period_year: 2023, period_month: 1, basic: 1, allowances: 0, bonus: 0, deductions: 0, status: "draft" };
    for (const [label, override, expectedCode] of [
      ["month 13 (payroll_month_range)", { period_month: 13 }, "invalid_period"],
      ["year 0 (payroll_year_range)", { period_year: 0 }, "invalid_period"],
      ["negative bonus (payroll_amounts_non_negative)", { bonus: -1 }, "invalid_amounts"],
      ["numeric overflow (22003)", { basic: 1e12 }, "invalid_amounts"],
    ]) {
      try {
        await container.payrollRepository.create({ ...base, ...override });
        record(`repository.create with ${label}`, false, "did not throw");
      } catch (error) {
        check(`repository.create with ${label} -> 400 ${expectedCode}`, error.statusCode === 400 && error.code === expectedCode, `${error.statusCode} ${error.code}`);
      }
    }

    // ---- soft delete records the deleter (D28) ----
    const del = await call("hr", "DELETE", `/${id1}`);
    check("DELETE a processed record as hr -> 204", del.status === 204, showing(del));
    const deleted = await rowOf(id1);
    check("soft delete: the row still exists with deleted_at set", deleted?.deleted_at, showing(deleted));
    check("soft delete: deleted_by_employee_id is the acting hr's employee id", deleted?.deleted_by_employee_id === hr.employeeId, `got ${deleted?.deleted_by_employee_id}`);
    check("a deleted record is gone from GET by id", (await call("admin", "GET", `/${id1}`)).status === 404, "still readable");
    check("a deleted record is gone from the list", !(await call("admin", "GET", "")).body.data.some((row) => row.id === id1), "still listed");
    check("deleting it again -> 404", (await call("admin", "DELETE", `/${id1}`)).status === 404, "not 404");
    check("PATCH of a deleted record -> 404", (await call("admin", "PATCH", `/${id1}`, { bonus: 1 })).status === 404, "not 404");
    const reprocessed = await call("admin", "POST", "", { employee_id: e1.employeeId, period_year: 2026, period_month: 9, bonus: 300 });
    check("the freed period can be processed again (partial unique index) -- the correction workflow", reprocessed.status === 201 && reprocessed.body.data.id !== id1 && near(reprocessed.body.data.bonus, 300), showing(reprocessed));
    const draftDelete = await call("admin", "DELETE", `/${(await call("admin", "POST", "", { employee_id: e2.employeeId, period_year: 2023, period_month: 12, status: "draft" })).body.data.id}`);
    check("DELETE a draft -> 204 too (any status)", draftDelete.status === 204, showing(draftDelete));
    for (const role of ["manager", "tl", "employee"]) {
      check(`DELETE as ${role} -> 403`, (await call(role, "DELETE", `/${reprocessed.body.data.id}`)).status === 403, "not 403");
    }

    // ---- migration 008's own constraints, in raw SQL ----
    try {
      await pool.query("UPDATE payroll SET deleted_by_employee_id = $1 WHERE id = $2", [admin.employeeId, reprocessed.body.data.id]);
      record("CHECK rejects a deleter on a live row", false, "the update succeeded");
    } catch (error) {
      check("CHECK rejects a deleter on a live row (23514 payroll_deleted_by_requires_deleted_at)",
        error.code === "23514" && error.constraint === "payroll_deleted_by_requires_deleted_at", `${error.code} ${error.constraint}`);
    }

    const disposable = await person("disposable", "employee");
    const { rows: [victim] } = await pool.query(
      "INSERT INTO payroll (employee_id, period_year, period_month, basic) VALUES ($1, 2022, 2, 1000) RETURNING id", [e1.employeeId]);
    await container.payrollRepository.deleteById(victim.id, disposable.employeeId);
    check("repository.deleteById records an arbitrary deleter", (await rowOf(victim.id)).deleted_by_employee_id === disposable.employeeId, "not recorded");
    await pool.query("DELETE FROM employees WHERE id = $1", [disposable.employeeId]);
    const orphaned = await rowOf(victim.id);
    check("hard-deleting the deleter's employee succeeds and ON DELETE SET NULL clears the pointer", orphaned.deleted_by_employee_id === null && orphaned.deleted_at !== null, showing(orphaned));

    // ---- foreign-key translation against the real constraint names ----
    try {
      await container.payrollRepository.create({ ...base, employee_id: randomUUID(), period_year: 2023, period_month: 2 });
      record("repository.create with a nonexistent employee", false, "did not throw");
    } catch (error) {
      check("repository.create with a nonexistent employee -> 400 invalid_employee (real FK name)", error.statusCode === 400 && error.code === "invalid_employee", `${error.statusCode} ${error.code}`);
    }
    const { rows: [target] } = await pool.query(
      "INSERT INTO payroll (employee_id, period_year, period_month, basic) VALUES ($1, 2022, 3, 1000) RETURNING id", [e1.employeeId]);
    try {
      await container.payrollRepository.deleteById(target.id, randomUUID());
      record("repository.deleteById with a nonexistent deleter", false, "did not throw");
    } catch (error) {
      check("repository.deleteById with a nonexistent deleter -> 400 invalid_reference (the deleter FK, not the employee one)", error.statusCode === 400 && error.code === "invalid_reference", `${error.statusCode} ${error.code}`);
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
    const tag = `p7e2e-${randomUUID().slice(0, 8)}`;
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

      // Pre-flight, before anything is written and before cleanup is armed: cleanup's own SQL
      // names the column migration 008 adds, so it cannot run on a database without it.
      const { rows: [{ present }] } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'payroll' AND column_name = 'deleted_by_employee_id') AS present`,
      );
      if (!present) throw new Error("Migration 008 is not applied to this database; run `npm run db:migrate` first.");

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
