/**
 * End-to-end check of the Phase 8 project and KPI write endpoints against a REAL PostgreSQL
 * database: the real container, repositories, services and routes (over HTTP), with only
 * authentication stubbed. The unit tests run against fakes and cannot see SQL, locks, constraint
 * names, the rating CHECKs, partial indexes, triggers or pg's number and date types; this can.
 *
 *   node scripts/e2e-projects-kpis.js --confirm-database=sigma_hrm_scratch
 *
 * Requires --confirm-database like every other write script in this repo, and refuses under
 * NODE_ENV=production. It needs the same backend/.env the API does (DATABASE_URL,
 * AUTH_TOKEN_SECRET, COMPANY_TIMEZONE), and migration 009 already applied (`npm run db:migrate`).
 *
 * It writes: departments, users, employees, projects, assignments and KPIs, all tagged
 * `p8e2e-<random>`. Everything it creates is deleted again in a `finally`, found by that tag rather
 * than by remembered ids, so a run that dies half-way through seeding still cleans up. It never
 * touches a row it did not create. Exits non-zero if any check fails.
 *
 * Among other things it proves, against the real database: the constraint and foreign-key names
 * the repositories' error translation assumes; the lock-then-count ordering that makes the
 * live-KPI refusals race-safe (two real concurrent interleavings); and that the self-rating and
 * legacy-KPI bans are refused by the DATABASE, not by the service.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
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
  const employees = "(SELECT id FROM employees WHERE employee_number LIKE $1)";
  const like = `${tag}-%`;
  await pool.query(
    `DELETE FROM kpis
     WHERE employee_id IN ${employees}
        OR deleted_by_employee_id IN ${employees}
        OR rated_by_employee_id IN ${employees}
        OR project_id IN (SELECT id FROM projects WHERE title LIKE $2)`,
    [like, `${tag} %`],
  );
  // project_assignments rows go with their project (ON DELETE CASCADE on the hard delete).
  await pool.query(
    `DELETE FROM projects
     WHERE title LIKE $2
        OR deleted_by_employee_id IN ${employees}
        OR department_id IN (SELECT id FROM departments WHERE name LIKE $1)`,
    [like, `${tag} %`],
  );
  await pool.query("UPDATE employees SET team_lead_id = NULL WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM employees WHERE employee_number LIKE $1", [like]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}-%@example.invalid`]);
  await pool.query("DELETE FROM departments WHERE name LIKE $1", [like]);
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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

  const department = async (suffix) => {
    const { rows: [row] } = await pool.query(
      "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id", [company.id, `${tag}-${suffix}`]);
    return row.id;
  };
  const person = async (label, role, departmentId, { teamLeadId = null, employmentStatus = "active" } = {}) => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (company_id, email, role) VALUES ($1, $2, $3) RETURNING id",
      [company.id, `${tag}-${label}@example.invalid`, role]);
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees (user_id, company_id, department_id, team_lead_id, employee_number, full_name, position_title,
                              joined_on, employment_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'E2E', '2024-01-01', $7) RETURNING id`,
      [user.id, company.id, departmentId, teamLeadId, `${tag}-${label}`, `${tag} ${label}`, employmentStatus]);
    return { userId: user.id, employeeId: employee.id, role, departmentId };
  };

  const deptA = await department("A");
  const deptB = await department("B");
  const admin = await person("admin", "admin", deptA);
  const hr = await person("hr", "hr", deptA);
  const manager = await person("manager", "manager", deptA);
  const tl1 = await person("tl1", "tl", deptA);
  const tl2 = await person("tl2", "tl", deptA);
  const tlB = await person("tlB", "tl", deptB);
  const e1 = await person("e1", "employee", deptA, { teamLeadId: tl1.employeeId });
  const e2 = await person("e2", "employee", deptA, { teamLeadId: tl1.employeeId });
  const e3 = await person("e3", "employee", deptA, { teamLeadId: tl2.employeeId });
  // eProm is the employee who is later promoted to manager (by raw SQL) to reach the self-rating ban;
  // a dedicated one, because once promoted they are no longer an eligible assignee anywhere.
  const eProm = await person("eProm", "employee", deptA, { teamLeadId: tl1.employeeId });
  const eTerm = await person("eTerm", "employee", deptA, { teamLeadId: tl1.employeeId, employmentStatus: "terminated" });
  const eB = await person("eB", "employee", deptB, { teamLeadId: tlB.employeeId });

  // -------------------------------------------------------------------------
  // The constraint, index and foreign-key names the translators assume, against what Postgres
  // actually generated.
  // -------------------------------------------------------------------------
  const { rows: foreignKeys } = await pool.query(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname, a.attname AS column_name
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid IN ('projects'::regclass, 'kpis'::regclass, 'project_assignments'::regclass) AND c.contype = 'f'`);
  console.info(`foreign keys as generated: ${foreignKeys.map((fk) => `${fk.table_name}.${fk.column_name} -> ${fk.conname}`).join("; ")}`);
  const fkNameFor = (table, column) => foreignKeys.find((fk) => fk.table_name === table && fk.column_name === column)?.conname;
  check("kpis.employee_id FK is named kpis_employee_id_fkey (the name the translator assumes)",
    fkNameFor("kpis", "employee_id") === "kpis_employee_id_fkey", `actual: ${fkNameFor("kpis", "employee_id")}`);
  check("kpis.project_id FK is named kpis_project_id_fkey (the name the translator assumes)",
    fkNameFor("kpis", "project_id") === "kpis_project_id_fkey", `actual: ${fkNameFor("kpis", "project_id")}`);
  check("kpis.deleted_by_employee_id FK is kpis_deleted_by_employee_id_fkey, distinct from the employee one",
    fkNameFor("kpis", "deleted_by_employee_id") === "kpis_deleted_by_employee_id_fkey", `actual: ${fkNameFor("kpis", "deleted_by_employee_id")}`);
  check("projects.deleted_by_employee_id FK is projects_deleted_by_employee_id_fkey",
    fkNameFor("projects", "deleted_by_employee_id") === "projects_deleted_by_employee_id_fkey", `actual: ${fkNameFor("projects", "deleted_by_employee_id")}`);

  const { rows: constraints } = await pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid IN ('projects'::regclass, 'kpis'::regclass, 'project_assignments'::regclass)");
  const { rows: indexes } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('projects', 'kpis', 'project_assignments')");
  const names = new Set([...constraints.map((row) => row.conname), ...indexes.map((row) => row.indexname)]);
  for (const name of [
    "projects_team_lead_department_foreign_key", "projects_department_company_foreign_key",
    "project_assignments_employee_department_foreign_key", "project_assignments_pkey",
    "projects_dates_ordered", "projects_title_not_blank", "projects_deleted_by_requires_deleted_at", "projects_deleted_by_index",
    "kpis_target_positive", "kpis_current_non_negative", "kpis_weight_range", "kpis_rating_range", "kpis_title_not_blank",
    "kpis_no_self_rating", "kpis_legacy_not_rateable", "kpis_rating_fields_consistent",
    "kpis_deleted_by_requires_deleted_at", "kpis_deleted_by_index",
  ]) {
    check(`constraint/index exists: ${name}`, names.has(name), `present: ${[...names].join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // HTTP: real container, repositories, services, routes; authentication stubbed
  // -------------------------------------------------------------------------
  resetContainer();
  const principals = { admin, hr, manager, tl1, tl2, employee: e1 };
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
    const projectRow = async (id) => (await pool.query("SELECT * FROM projects WHERE id = $1", [id])).rows[0];
    const kpiRow = async (id) => (await pool.query("SELECT * FROM kpis WHERE id = $1", [id])).rows[0];
    const assignmentsOf = async (id) => (await pool.query(
      "SELECT employee_id, department_id, assigned_at FROM project_assignments WHERE project_id = $1", [id])).rows;
    const idsOf = (rows) => rows.map((row) => row.employee_id);
    const projectBody = (label, overrides = {}) => ({
      department_id: deptA, team_lead_id: tl1.employeeId, title: `${tag} ${label}`, description: "e2e",
      start_date: "2026-03-01", due_date: "2026-04-15", assigned_employee_ids: [e1.employeeId, e2.employeeId], ...overrides,
    });
    const kpiBody = (projectId, employeeId, overrides = {}) => ({
      project_id: projectId, employee_id: employeeId, title: "e2e kpi", target: 1000.5, current_value: 0, weight: 40, period: "Q1", ...overrides,
    });
    const createProject = async (as, label, overrides) => (await call(as, "POST", "/projects", projectBody(label, overrides)));

    // ======================================================================
    // Projects: create, defaults, serialization
    // ======================================================================
    const created = await createProject("manager", "main");
    check("POST /projects as manager (own department) -> 201", created.status === 201, showing(created));
    const main = created.body?.data;
    check("status defaults to active (parity with the frontend form), not the column's draft", main?.status === "active", showing(main));
    check("start_date and due_date come back as plain YYYY-MM-DD strings", main?.start_date === "2026-03-01" && main?.due_date === "2026-04-15", showing(main));
    check("the response keeps the read shape: assignedEmployeeIds, not assigned_employee_ids (the deferred inconsistency)",
      sameSet(main?.assignedEmployeeIds ?? [], [e1.employeeId, e2.employeeId]) && !Object.hasOwn(main ?? {}, "assigned_employee_ids"), showing(main));
    check("server-set created_at/updated_at present", main?.created_at && main?.updated_at, showing(main));
    check("the database row agrees: active, department and lead as sent", (await projectRow(main?.id))?.status === "active" && (await projectRow(main?.id))?.team_lead_id === tl1.employeeId, showing(await projectRow(main?.id)));

    const rawProject = (await pool.query("SELECT start_date, status FROM projects WHERE id = $1", [main?.id])).rows[0];
    check("control: a raw `date` column really does come back from pg as a JS Date (local-midnight), so the to_char fix matters",
      rawProject?.start_date instanceof Date, showing(rawProject));
    const { rows: [bare] } = await pool.query(
      `INSERT INTO projects (company_id, department_id, title, description, start_date, due_date)
       VALUES ($1, $2, $3, '', '2026-01-01', '2026-01-02') RETURNING status`, [company.id, deptA, `${tag} bare insert`]);
    check("control: the COLUMN default is still draft -- the API's active default is deliberate, not the schema's", bare.status === "draft", showing(bare));

    const draft = await createProject("admin", "explicit draft", { status: "draft" });
    check("an explicit status: draft is honored", draft.status === 201 && draft.body.data.status === "draft", showing(draft));

    const listedProjects = await call("admin", "GET", "/projects");
    check("GET /projects list returns date strings too", listedProjects.body?.data?.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)), showing(listedProjects.body).slice(0, 200));

    // ---- scoped defaults and validation ----
    const tlDefaults = await call("tl1", "POST", "/projects", {
      title: `${tag} tl defaults`, start_date: "2026-03-01", due_date: "2026-04-01", assigned_employee_ids: [e1.employeeId],
    });
    check("a tl creating with no department or lead gets their own department and leads it themselves", tlDefaults.status === 201
      && (await projectRow(tlDefaults.body?.data?.id))?.department_id === deptA
      && (await projectRow(tlDefaults.body?.data?.id))?.team_lead_id === tl1.employeeId, showing(tlDefaults));
    const tlOtherLead = await createProject("tl1", "tl other lead", { team_lead_id: tl2.employeeId });
    check("a tl naming ANOTHER lead is refused 403, not rewritten", tlOtherLead.status === 403 && tlOtherLead.body.error.code === "project_scope_denied", showing(tlOtherLead));
    const tlNullLead = await createProject("tl1", "tl null lead", { team_lead_id: null });
    check("a tl sending an explicit null lead is refused 403, not rewritten", tlNullLead.status === 403, showing(tlNullLead));
    const tlOffTeam = await createProject("tl1", "tl off-team", { assigned_employee_ids: [e1.employeeId, e3.employeeId] });
    check("a tl assigning someone from another team is refused 403", tlOffTeam.status === 403, showing(tlOffTeam));
    const employeeCreate = await createProject("employee", "denied");
    check("an employee-role principal cannot create -> 403 role_not_allowed", employeeCreate.status === 403 && employeeCreate.body.error.code === "role_not_allowed", showing(employeeCreate));
    check("a terminated assignee -> 400 invalid_assignee", (await createProject("admin", "term", { assigned_employee_ids: [e1.employeeId, eTerm.employeeId] })).body?.error?.code === "invalid_assignee", "");
    check("an assignee from another department -> 400 invalid_assignee", (await createProject("admin", "xdept", { assigned_employee_ids: [eB.employeeId] })).body?.error?.code === "invalid_assignee", "");
    check("a lead who is not a tl -> 400 invalid_team_lead", (await createProject("admin", "badlead", { team_lead_id: e1.employeeId })).body?.error?.code === "invalid_team_lead", "");
    check("an empty assignee list -> 400", (await createProject("admin", "empty", { assigned_employee_ids: [] })).status === 400, "");
    check("a duplicated assignee -> 400", (await createProject("admin", "dupe", { assigned_employee_ids: [e1.employeeId, e1.employeeId] })).status === 400, "");

    // ======================================================================
    // Projects: the assignee replace-set
    // ======================================================================
    const before = await assignmentsOf(main.id);
    const e2Before = before.find((row) => row.employee_id === e2.employeeId);
    const projectBeforeEdit = await projectRow(main.id);
    await sleep(25);
    const replaced = await call("admin", "PATCH", `/projects/${main.id}`, { assigned_employee_ids: [e2.employeeId, e3.employeeId] });
    check("PATCH assigned_employee_ids replaces the set -> 200", replaced.status === 200 && sameSet(replaced.body.data.assignedEmployeeIds, [e2.employeeId, e3.employeeId]), showing(replaced));
    const afterRows = await assignmentsOf(main.id);
    check("the database holds exactly the new set", sameSet(idsOf(afterRows), [e2.employeeId, e3.employeeId]), showing(idsOf(afterRows)));
    check("replace is by DIFFERENCE: the unchanged assignee keeps their row and assigned_at",
      +afterRows.find((row) => row.employee_id === e2.employeeId)?.assigned_at === +e2Before.assigned_at, showing(afterRows));
    check("every assignment row carries the project's department (what the composite FKs check)", afterRows.every((row) => row.department_id === deptA), showing(afterRows));
    const projectAfterEdit = await projectRow(main.id);
    check("an assignment-only change still advances updated_at (the trigger fired)", projectAfterEdit.updated_at > projectBeforeEdit.updated_at, `${projectBeforeEdit.updated_at.toISOString()} -> ${projectAfterEdit.updated_at.toISOString()}`);

    const emptied = await call("admin", "PATCH", `/projects/${main.id}`, { assigned_employee_ids: [] });
    check("replacing with an empty set -> 400, and the assignments are untouched", emptied.status === 400 && sameSet(idsOf(await assignmentsOf(main.id)), [e2.employeeId, e3.employeeId]), showing(emptied));
    const duplicated = await call("admin", "PATCH", `/projects/${main.id}`, { assigned_employee_ids: [e2.employeeId, e2.employeeId] });
    check("replacing with duplicates -> 400", duplicated.status === 400, showing(duplicated));

    // ---- department change ----
    const mover = (await createProject("admin", "mover", { assigned_employee_ids: [e1.employeeId] })).body.data;
    const alone = await call("admin", "PATCH", `/projects/${mover.id}`, { department_id: deptB });
    check("a department change alone -> 400 (lead and assignees must be restated)", alone.status === 400, showing(alone));
    const staleAssignee = await call("admin", "PATCH", `/projects/${mover.id}`, { department_id: deptB, team_lead_id: tlB.employeeId, assigned_employee_ids: [e1.employeeId] });
    check("a department change keeping an assignee from the OLD department -> 400 invalid_assignee", staleAssignee.status === 400 && staleAssignee.body.error.code === "invalid_assignee", showing(staleAssignee));
    const moved = await call("admin", "PATCH", `/projects/${mover.id}`, { department_id: deptB, team_lead_id: tlB.employeeId, assigned_employee_ids: [eB.employeeId] });
    check("admin moves a project to another department with a new lead and assignees -> 200", moved.status === 200, showing(moved));
    const movedRows = await assignmentsOf(mover.id);
    check("after the move: department, lead and the ONLY assignment row are all in the new department",
      (await projectRow(mover.id)).department_id === deptB && (await projectRow(mover.id)).team_lead_id === tlB.employeeId
      && sameSet(idsOf(movedRows), [eB.employeeId]) && movedRows.every((row) => row.department_id === deptB), showing(movedRows));
    const managerMove = await call("manager", "PATCH", `/projects/${main.id}`, { department_id: deptB, team_lead_id: null, assigned_employee_ids: [eB.employeeId] });
    check("a manager moving their project into another department -> 403", managerMove.status === 403 && managerMove.body.error.code === "project_scope_denied", showing(managerMove));
    const managerForeign = await call("manager", "PATCH", `/projects/${mover.id}`, { title: `${tag} hijack` });
    check("a manager editing a project in another department -> 403", managerForeign.status === 403, showing(managerForeign));
    check("...nor deleting it -> 403", (await call("manager", "DELETE", `/projects/${mover.id}`)).status === 403, "");

    // ======================================================================
    // Projects: the two-sided TL scope, against real rows
    // ======================================================================
    const ptl = (await createProject("admin", "tl-owned", { assigned_employee_ids: [e1.employeeId, e2.employeeId] })).body.data;
    check("a tl who leads a project, with their own team on it, may edit it", (await call("tl1", "PATCH", `/projects/${ptl.id}`, { title: `${tag} tl-owned renamed` })).status === 200, "");
    const addOffTeam = await call("tl1", "PATCH", `/projects/${ptl.id}`, { assigned_employee_ids: [e1.employeeId, e3.employeeId] });
    check("RESULTING side: that tl adding an assignee from another team -> 403", addOffTeam.status === 403 && addOffTeam.body.error.code === "project_scope_denied", showing(addOffTeam));
    check("...and the assignments were not touched", sameSet(idsOf(await assignmentsOf(ptl.id)), [e1.employeeId, e2.employeeId]), "");
    const handOver = await call("tl1", "PATCH", `/projects/${ptl.id}`, { team_lead_id: tl2.employeeId });
    check("RESULTING side: that tl handing the project to another lead -> 403", handOver.status === 403, showing(handOver));
    check("EXISTING side: a tl with no stake cannot edit it -> 403", (await call("tl2", "PATCH", `/projects/${ptl.id}`, { title: "x" })).status === 403, "");
    check("...nor delete it -> 403", (await call("tl2", "DELETE", `/projects/${ptl.id}`)).status === 403, "");

    const pshared = (await createProject("admin", "shared", { team_lead_id: tl2.employeeId, assigned_employee_ids: [e1.employeeId, e3.employeeId] })).body.data;
    const notLeadEdit = await call("tl1", "PATCH", `/projects/${pshared.id}`, { title: `${tag} shared renamed` });
    check("a tl who is NOT the lead but has a member (e1) on it cannot EDIT it -> 403", notLeadEdit.status === 403, showing(notLeadEdit));
    const notLeadDelete = await call("tl1", "DELETE", `/projects/${pshared.id}`);
    check("...yet CAN DELETE it (existing scope only) -> 204", notLeadDelete.status === 204, showing(notLeadDelete));
    const sharedRow = await projectRow(pshared.id);
    check("that delete is soft and records the tl as the deleter", sharedRow.deleted_at && sharedRow.deleted_by_employee_id === tl1.employeeId, showing(sharedRow));

    // ======================================================================
    // KPIs: create, serialization, scope
    // ======================================================================
    const pk = (await createProject("admin", "kpi-host", { assigned_employee_ids: [e1.employeeId, e2.employeeId, eProm.employeeId] })).body.data;
    const k1res = await call("manager", "POST", "/kpis", kpiBody(pk.id, e1.employeeId));
    check("POST /kpis as manager (own department) -> 201", k1res.status === 201, showing(k1res));
    const k1 = k1res.body?.data;
    check("KPI amounts come back as JSON numbers, not strings", near(k1?.target, 1000.5) && near(k1?.current_value, 0), showing(k1));
    check("status defaults to active and the KPI is born unrated", k1?.status === "active" && k1?.rating === null && k1?.rated_by_employee_id === null && k1?.rated_at === null, showing(k1));
    const rawKpi = (await pool.query("SELECT target, current_value FROM kpis WHERE id = $1", [k1?.id])).rows[0];
    check("control: a raw numeric column really does come back from pg as a string, so the float8 cast matters",
      typeof rawKpi?.target === "string" && typeof rawKpi?.current_value === "string", showing(rawKpi));
    const listedKpis = await call("admin", "GET", "/kpis");
    check("GET /kpis list returns numeric amounts", listedKpis.body?.data?.length > 0 && listedKpis.body.data.every((row) => typeof row.target === "number" && typeof row.current_value === "number"), showing(listedKpis.body).slice(0, 200));
    check("GET /kpis/:id is not shadowed by the write router", (await call("admin", "GET", `/kpis/${k1.id}`)).body?.data?.id === k1.id, "");

    check("an employee-role principal cannot create a KPI -> 403", (await call("employee", "POST", "/kpis", kpiBody(pk.id, e1.employeeId))).status === 403, "");
    check("an employee who is NOT assigned to the project -> 400 employee_not_assigned (the real lock query)",
      (await call("admin", "POST", "/kpis", kpiBody(pk.id, e3.employeeId))).body?.error?.code === "employee_not_assigned", "");
    check("a terminated employee -> 400 employee_not_eligible", (await call("admin", "POST", "/kpis", kpiBody(pk.id, eTerm.employeeId))).body?.error?.code === "employee_not_eligible", "");
    check("an unknown project -> 400 invalid_project", (await call("admin", "POST", "/kpis", kpiBody(randomUUID(), e1.employeeId))).body?.error?.code === "invalid_project", "");
    check("a null project (no new legacy KPIs) -> 400", (await call("admin", "POST", "/kpis", kpiBody(null, e1.employeeId))).status === 400, "");
    const tlKpi = await call("tl1", "POST", "/kpis", kpiBody(pk.id, e2.employeeId));
    check("a tl creating a KPI for an employee on their team, on a project with their people -> 201", tlKpi.status === 201, showing(tlKpi));
    const pForTl2 = (await createProject("admin", "tl2-host", { team_lead_id: tl2.employeeId, assigned_employee_ids: [e3.employeeId] })).body.data;
    check("a tl creating a KPI for an employee on another team -> 403 kpi_scope_denied", (await call("tl1", "POST", "/kpis", kpiBody(pForTl2.id, e3.employeeId))).body?.error?.code === "kpi_scope_denied", "");
    const pInB = (await createProject("admin", "dept-b", { department_id: deptB, team_lead_id: tlB.employeeId, assigned_employee_ids: [eB.employeeId] })).body.data;
    check("a manager creating a KPI on a project in another department -> 403", (await call("manager", "POST", "/kpis", kpiBody(pInB.id, eB.employeeId))).status === 403, "");

    // ======================================================================
    // KPIs: frozen employee_id and project_id, progress edits
    // ======================================================================
    const kBefore = await kpiRow(k1.id);
    await sleep(25);
    const progress = await call("tl1", "PATCH", `/kpis/${k1.id}`, { current_value: 12.5, title: "renamed e2e kpi" });
    check("a progress edit -> 200, current_value returned as a number", progress.status === 200 && near(progress.body.data.current_value, 12.5) && progress.body.data.title === "renamed e2e kpi", showing(progress));
    const kAfter = await kpiRow(k1.id);
    check("updated_at advanced by the trigger; created_at unchanged", kAfter.updated_at > kBefore.updated_at && +kAfter.created_at === +kBefore.created_at, "");
    for (const body of [{ employee_id: e2.employeeId }, { project_id: pForTl2.id }]) {
      const refused = await call("admin", "PATCH", `/kpis/${k1.id}`, body);
      check(`PATCH ${showing(body).slice(0, 30)}... (frozen) -> 400`, refused.status === 400, showing(refused));
    }
    const kFrozen = await kpiRow(k1.id);
    check("the KPI's employee and project are unchanged in the database", kFrozen.employee_id === e1.employeeId && kFrozen.project_id === pk.id, showing(kFrozen));
    check("rating cannot be set through PATCH -> 400", (await call("admin", "PATCH", `/kpis/${k1.id}`, { rating: 5 })).status === 400, "");

    // ======================================================================
    // The live-KPI refusals, with the real count
    // ======================================================================
    // Removes e1 only (e2 and eProm stay): e1 has a live KPI, so the whole replace is refused.
    const blockedRemoval = await call("admin", "PATCH", `/projects/${pk.id}`, { assigned_employee_ids: [e2.employeeId, eProm.employeeId] });
    check("removing an assignee who has a live KPI -> 409 assignee_has_kpis", blockedRemoval.status === 409 && blockedRemoval.body.error.code === "assignee_has_kpis", showing(blockedRemoval));
    check("...carrying the real count", blockedRemoval.body?.error?.details?.live_kpi_count === 1 && /\b1\b/.test(blockedRemoval.body?.error?.message ?? ""), showing(blockedRemoval.body?.error));
    check("...and the assignments are unchanged", sameSet(idsOf(await assignmentsOf(pk.id)), [e1.employeeId, e2.employeeId, eProm.employeeId]), "");
    const blockedDelete = await call("admin", "DELETE", `/projects/${pk.id}`);
    check("deleting a project with live KPIs -> 409 project_has_kpis carrying the count (2: e1's and e2's)",
      blockedDelete.status === 409 && blockedDelete.body.error.code === "project_has_kpis" && blockedDelete.body.error.details?.live_kpi_count === 2, showing(blockedDelete));
    check("...and the project is untouched", (await projectRow(pk.id)).deleted_at === null, "");

    // ======================================================================
    // Rating, and the two database bans
    // ======================================================================
    const rated = await call("manager", "POST", `/kpis/${k1.id}/rating`, { rating: 8 });
    check("POST /kpis/:id/rating as manager -> 200", rated.status === 200 && rated.body.data.rating === 8, showing(rated));
    check("the rater is the manager and the time is the server's, in the response and the database",
      rated.body?.data?.rated_by_employee_id === manager.employeeId && Boolean(rated.body?.data?.rated_at)
      && (await kpiRow(k1.id)).rated_by_employee_id === manager.employeeId && (await kpiRow(k1.id)).rated_at !== null, showing(rated.body?.data));
    const firstRatedAt = (await kpiRow(k1.id)).rated_at;
    await sleep(25);
    const reRated = await call("tl1", "POST", `/kpis/${k1.id}/rating`, { rating: 3 });
    const reRatedRow = await kpiRow(k1.id);
    check("a re-rating overwrites rating, rater AND time together", reRated.status === 200 && reRatedRow.rating === 3
      && reRatedRow.rated_by_employee_id === tl1.employeeId && reRatedRow.rated_at > firstRatedAt, showing(reRatedRow));
    check("a client can never say who rated or when -> 400", (await call("admin", "POST", `/kpis/${k1.id}/rating`, { rating: 5, rated_by_employee_id: e2.employeeId })).status === 400
      && (await call("admin", "POST", `/kpis/${k1.id}/rating`, { rating: 5, rated_at: "2020-01-01T00:00:00Z" })).status === 400, "");
    check("a rating out of range is refused at the door (400)", (await call("admin", "POST", `/kpis/${k1.id}/rating`, { rating: 11 })).status === 400
      && (await call("admin", "POST", `/kpis/${k1.id}/rating`, { rating: 0 })).status === 400, "");
    try {
      await container.kpiRepository.rate(k1.id, { rating: 11, ratedByEmployeeId: manager.employeeId });
      record("the DATABASE refuses a rating of 11 (repository, bypassing the schema)", false, "did not throw");
    } catch (error) {
      check("the DATABASE refuses a rating of 11 (kpis_rating_range) -> 400 invalid_rating", error.statusCode === 400 && error.code === "invalid_rating", `${error.statusCode} ${error.code}`);
    }
    check("a rater out of scope is refused 403 kpi_scope_denied (a tl on another team)", (await call("tl2", "POST", `/kpis/${k1.id}/rating`, { rating: 5 })).body?.error?.code === "kpi_scope_denied", "");

    // ---- legacy KPI: ban enforced by the database ----
    const { rows: [legacy] } = await pool.query(
      `INSERT INTO kpis (project_id, employee_id, title, target, weight, period)
       VALUES (NULL, $1, 'legacy', 100, 10, 'Q1') RETURNING id`, [e1.employeeId]);
    const legacyRate = await call("admin", "POST", `/kpis/${legacy.id}/rating`, { rating: 5 });
    check("rating a LEGACY KPI -> 409 legacy_kpi_not_rateable, refused by kpis_legacy_not_rateable", legacyRate.status === 409 && legacyRate.body.error.code === "legacy_kpi_not_rateable", showing(legacyRate));
    const legacyRow = await kpiRow(legacy.id);
    check("...and nothing was written: the legacy KPI is still unrated", legacyRow.rating === null && legacyRow.rated_by_employee_id === null && legacyRow.rated_at === null, showing(legacyRow));
    check("a legacy KPI can still be edited (-> 200) and deleted (-> 204)",
      (await call("admin", "PATCH", `/kpis/${legacy.id}`, { current_value: 3 })).status === 200 && (await call("admin", "DELETE", `/kpis/${legacy.id}`)).status === 204, "");

    // ---- self-rating: ban enforced by the database, reached via a role change ----
    const k2 = (await call("admin", "POST", "/kpis", kpiBody(pk.id, eProm.employeeId, { title: "self-rating target" }))).body.data;
    await pool.query("UPDATE users SET role = 'manager' WHERE id = $1", [eProm.userId]);
    principals.promotedAsManager = { userId: eProm.userId, employeeId: eProm.employeeId, role: "manager", departmentId: deptA };
    const selfRate = await call("promotedAsManager", "POST", `/kpis/${k2.id}/rating`, { rating: 10 });
    check("an employee promoted to manager rating their OWN KPI -> 403 self_rating_denied, refused by kpis_no_self_rating (the service authorized it)",
      selfRate.status === 403 && selfRate.body.error.code === "self_rating_denied", showing(selfRate));
    const k2Row = await kpiRow(k2.id);
    check("...and nothing was written: the KPI is still unrated", k2Row.rating === null && k2Row.rated_by_employee_id === null && k2Row.rated_at === null, showing(k2Row));
    const otherRates = await call("manager", "POST", `/kpis/${k2.id}/rating`, { rating: 7 });
    check("the same KPI is rateable by someone else -> 200", otherRates.status === 200 && otherRates.body.data.rated_by_employee_id === manager.employeeId, showing(otherRates));

    // ---- the three rating constraints, directly in SQL ----
    const rawError = async (sql, params) => {
      try { await pool.query(sql, params); return null; } catch (error) { return error; }
    };
    const unrated = (await call("admin", "POST", "/kpis", kpiBody(pk.id, e1.employeeId, { title: "raw ban target" }))).body.data;
    let error = await rawError("UPDATE kpis SET rating = 5 WHERE id = $1", [unrated.id]);
    check("raw SQL: a rating without a rater and time -> 23514 kpis_rating_fields_consistent", error?.code === "23514" && error.constraint === "kpis_rating_fields_consistent", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE kpis SET rating = 5, rated_by_employee_id = employee_id, rated_at = now() WHERE id = $1", [unrated.id]);
    check("raw SQL: rating one's own KPI -> 23514 kpis_no_self_rating", error?.code === "23514" && error.constraint === "kpis_no_self_rating", `${error?.code} ${error?.constraint}`);
    error = await rawError("UPDATE kpis SET project_id = NULL, rating = 5, rated_by_employee_id = $2, rated_at = now() WHERE id = $1", [unrated.id, admin.employeeId]);
    check("raw SQL: rating a project-less KPI -> 23514 kpis_legacy_not_rateable", error?.code === "23514" && error.constraint === "kpis_legacy_not_rateable", `${error?.code} ${error?.constraint}`);
    error = await rawError("INSERT INTO kpis (project_id, employee_id, title, target, weight, period) VALUES ($1, $2, 't', 1, 1, 'q')", [randomUUID(), e1.employeeId]);
    check("raw SQL: a KPI on an unknown project -> 23503 kpis_project_id_fkey", error?.code === "23503" && error.constraint === "kpis_project_id_fkey", `${error?.code} ${error?.constraint}`);
    error = await rawError("INSERT INTO kpis (project_id, employee_id, title, target, weight, period) VALUES ($1, $2, 't', 1, 1, 'q')", [pk.id, randomUUID()]);
    check("raw SQL: a KPI for an unknown employee -> 23503 kpis_employee_id_fkey", error?.code === "23503" && error.constraint === "kpis_employee_id_fkey", `${error?.code} ${error?.constraint}`);

    // ---- repository-level CHECK translations, through the real constraint names ----
    for (const [label, changes, expected] of [
      ["target 0 (kpis_target_positive)", { target: 0 }, "invalid_target"],
      ["current_value -1 (kpis_current_non_negative)", { current_value: -1 }, "invalid_current_value"],
      ["weight 0 (kpis_weight_range)", { weight: 0 }, "invalid_weight"],
      ["numeric overflow (22003)", { target: 1e15 }, "invalid_amounts"],
    ]) {
      try {
        await container.kpiRepository.updateById(unrated.id, changes);
        record(`repository.updateById with ${label}`, false, "did not throw");
      } catch (e) {
        check(`repository.updateById with ${label} -> 400 ${expected}`, e.statusCode === 400 && e.code === expected, `${e.statusCode} ${e.code}`);
      }
    }
    // ---- project repository translations, through the real constraint names ----
    const projectInput = (overrides) => ({
      department_id: deptA, team_lead_id: null, title: `${tag} repo`, description: "", start_date: "2026-01-01",
      due_date: "2026-02-01", status: "active", assigned_employee_ids: [e1.employeeId], ...overrides,
    });
    for (const [label, overrides, expected] of [
      ["a lead from another department (projects_team_lead_department_foreign_key)", { team_lead_id: tlB.employeeId }, "invalid_team_lead"],
      ["an assignee from another department (project_assignments_employee_department_foreign_key)", { assigned_employee_ids: [eB.employeeId] }, "invalid_assignee"],
      ["due before start (projects_dates_ordered)", { start_date: "2026-03-01", due_date: "2026-01-01" }, "invalid_dates"],
      ["an unknown department", { department_id: randomUUID() }, "invalid_department"],
    ]) {
      try {
        await container.projectRepository.create(projectInput(overrides));
        record(`projectRepository.create with ${label}`, false, "did not throw");
      } catch (e) {
        check(`projectRepository.create with ${label} -> 400 ${expected}`, e.statusCode === 400 && e.code === expected, `${e.statusCode} ${e.code}`);
      }
    }
    check("none of those refused creates left a project behind", (await pool.query("SELECT count(*)::int AS n FROM projects WHERE title = $1", [`${tag} repo`])).rows[0].n === 0, "");

    // ======================================================================
    // Real concurrency: lock-then-count, both interleavings
    // ======================================================================
    const raceProject = (await createProject("admin", "race-a", { assigned_employee_ids: [e1.employeeId, e2.employeeId] })).body.data;
    {
      // A KPI create in flight (project and assignment locked FOR SHARE, row inserted, uncommitted)
      // when an assignee removal arrives. The removal must wait, then count the KPI and refuse.
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR SHARE", [raceProject.id]);
        await holder.query("SELECT 1 FROM project_assignments WHERE project_id = $1 AND employee_id = $2 FOR SHARE", [raceProject.id, e1.employeeId]);
        await holder.query(
          "INSERT INTO kpis (project_id, employee_id, title, target, weight, period) VALUES ($1, $2, 'in flight', 10, 5, 'Q1')",
          [raceProject.id, e1.employeeId]);
        let settled = false;
        const removal = call("admin", "PATCH", `/projects/${raceProject.id}`, { assigned_employee_ids: [e2.employeeId] })
          .then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 1: an assignee removal WAITS while a KPI create for that assignee is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await removal;
        check("RACE 1: once the KPI commits, the removal sees it and refuses -> 409 assignee_has_kpis with count 1",
          response.status === 409 && response.body.error.code === "assignee_has_kpis" && response.body.error.details?.live_kpi_count === 1, showing(response));
        check("RACE 1: the assignment was not removed", sameSet(idsOf(await assignmentsOf(raceProject.id)), [e1.employeeId, e2.employeeId]), "");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }
    {
      // A project edit that removes an assignee is in flight (project locked FOR UPDATE, assignment
      // deleted, uncommitted) when a KPI create for that assignee arrives. The create must wait, then
      // find the assignment gone and refuse -- never a KPI stranded on a removed assignee.
      const raceB = (await createProject("admin", "race-b", { assigned_employee_ids: [e1.employeeId, e2.employeeId] })).body.data;
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [raceB.id]);
        await holder.query("DELETE FROM project_assignments WHERE project_id = $1 AND employee_id = $2", [raceB.id, e1.employeeId]);
        let settled = false;
        const create = call("admin", "POST", "/kpis", kpiBody(raceB.id, e1.employeeId, { title: "late arrival" }))
          .then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 2: a KPI create WAITS while an assignee removal for that employee is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await create;
        check("RACE 2: once the removal commits, the create finds the assignment gone -> 400 employee_not_assigned",
          response.status === 400 && response.body.error.code === "employee_not_assigned", showing(response));
        check("RACE 2: no KPI was stranded on the removed assignee", (await pool.query("SELECT count(*)::int AS n FROM kpis WHERE project_id = $1", [raceB.id])).rows[0].n === 0, "");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }
    {
      // The same, for a project delete against a KPI create in flight.
      const raceC = (await createProject("admin", "race-c", { assigned_employee_ids: [e1.employeeId] })).body.data;
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR SHARE", [raceC.id]);
        await holder.query("SELECT 1 FROM project_assignments WHERE project_id = $1 AND employee_id = $2 FOR SHARE", [raceC.id, e1.employeeId]);
        await holder.query(
          "INSERT INTO kpis (project_id, employee_id, title, target, weight, period) VALUES ($1, $2, 'in flight', 10, 5, 'Q1')",
          [raceC.id, e1.employeeId]);
        let settled = false;
        const removal = call("admin", "DELETE", `/projects/${raceC.id}`).then((response) => { settled = true; return response; });
        await sleep(600);
        check("RACE 3: a project delete WAITS while a KPI create on it is in flight (uncommitted)", settled === false, "it did not wait");
        await holder.query("COMMIT");
        const response = await removal;
        check("RACE 3: once the KPI commits, the delete counts it and refuses -> 409 project_has_kpis with count 1",
          response.status === 409 && response.body.error.code === "project_has_kpis" && response.body.error.details?.live_kpi_count === 1, showing(response));
        check("RACE 3: the project was not deleted", (await projectRow(raceC.id)).deleted_at === null, "");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    }

    // ======================================================================
    // Soft delete: KPIs first, then the project that was blocked
    // ======================================================================
    const kDelete = await call("hr", "DELETE", `/kpis/${k1.id}`);
    check("DELETE /kpis/:id as hr -> 204", kDelete.status === 204, showing(kDelete));
    const kDeleted = await kpiRow(k1.id);
    check("KPI soft delete: the row still exists with deleted_at set and the acting hr recorded", kDeleted?.deleted_at && kDeleted.deleted_by_employee_id === hr.employeeId, showing(kDeleted));
    check("a deleted KPI is gone from GET, the list, PATCH, rating and a second DELETE",
      (await call("admin", "GET", `/kpis/${k1.id}`)).status === 404
      && !(await call("admin", "GET", "/kpis")).body.data.some((row) => row.id === k1.id)
      && (await call("admin", "PATCH", `/kpis/${k1.id}`, { title: "x" })).status === 404
      && (await call("admin", "POST", `/kpis/${k1.id}/rating`, { rating: 5 })).status === 404
      && (await call("admin", "DELETE", `/kpis/${k1.id}`)).status === 404, "");

    // k2 and tlKpi and `unrated` are still live on pk; soft-delete them all, then the blocks lift.
    for (const id of [k2.id, tlKpi.body.data.id, unrated.id]) await call("admin", "DELETE", `/kpis/${id}`);
    check("with every KPI soft-deleted, only LIVE ones count: the assignee removal that was refused now succeeds",
      (await call("admin", "PATCH", `/projects/${pk.id}`, { assigned_employee_ids: [e2.employeeId] })).status === 200, "");
    const pDelete = await call("admin", "DELETE", `/projects/${pk.id}`);
    check("...and so does the project delete -> 204", pDelete.status === 204, showing(pDelete));
    const pDeleted = await projectRow(pk.id);
    check("project soft delete: the row still exists with deleted_at set and the acting admin recorded", pDeleted?.deleted_at && pDeleted.deleted_by_employee_id === admin.employeeId, showing(pDeleted));
    check("the project's assignment rows are left in place, hidden with it", idsOf(await assignmentsOf(pk.id)).length === 1, showing(await assignmentsOf(pk.id)));
    check("a deleted project is gone from GET, the list, PATCH and a second DELETE",
      (await call("admin", "GET", `/projects/${pk.id}`)).status === 404
      && !(await call("admin", "GET", "/projects")).body.data.some((row) => row.id === pk.id)
      && (await call("admin", "PATCH", `/projects/${pk.id}`, { title: "x" })).status === 404
      && (await call("admin", "DELETE", `/projects/${pk.id}`)).status === 404, "");
    check("a KPI cannot be created on a deleted project -> 400 invalid_project", (await call("admin", "POST", "/kpis", kpiBody(pk.id, e2.employeeId))).body?.error?.code === "invalid_project", "");

    // ======================================================================
    // Migration 009's own constraints, in raw SQL
    // ======================================================================
    // `main` is a live project, and e2 is still assigned to it, so a KPI there is a live KPI.
    const liveKpi = (await call("admin", "POST", "/kpis", kpiBody(main.id, e2.employeeId, { title: "live row" }))).body.data;
    for (const [table, liveId] of [["projects", main.id], ["kpis", liveKpi?.id]]) {
      error = await rawError(`UPDATE ${table} SET deleted_by_employee_id = $1 WHERE id = $2`, [admin.employeeId, liveId]);
      check(`CHECK rejects a deleter on a live ${table} row (23514 ${table}_deleted_by_requires_deleted_at)`,
        error?.code === "23514" && error.constraint === `${table}_deleted_by_requires_deleted_at`, `${error?.code} ${error?.constraint}`);
    }

    const disposable = await person("disposable", "manager", deptA);
    const { rows: [orphanProject] } = await pool.query(
      `INSERT INTO projects (company_id, department_id, title, description, start_date, due_date)
       VALUES ($1, $2, $3, '', '2026-01-01', '2026-01-02') RETURNING id`, [company.id, deptA, `${tag} orphan project`]);
    await container.projectRepository.deleteById(orphanProject.id, disposable.employeeId);
    const orphanKpiProject = (await createProject("admin", "orphan-kpi-host", { assigned_employee_ids: [e1.employeeId] })).body.data;
    const orphanKpi = (await call("admin", "POST", "/kpis", kpiBody(orphanKpiProject.id, e1.employeeId, { title: "orphan kpi" }))).body.data;
    await container.kpiRepository.deleteById(orphanKpi.id, disposable.employeeId);
    check("both repositories record an arbitrary deleter", (await projectRow(orphanProject.id)).deleted_by_employee_id === disposable.employeeId
      && (await kpiRow(orphanKpi.id)).deleted_by_employee_id === disposable.employeeId, "");
    await pool.query("DELETE FROM employees WHERE id = $1", [disposable.employeeId]);
    const orphanedProject = await projectRow(orphanProject.id);
    const orphanedKpi = await kpiRow(orphanKpi.id);
    check("hard-deleting the deleter succeeds and ON DELETE SET NULL clears BOTH pointers, keeping deleted_at",
      orphanedProject.deleted_by_employee_id === null && orphanedProject.deleted_at !== null
      && orphanedKpi.deleted_by_employee_id === null && orphanedKpi.deleted_at !== null, showing({ orphanedProject: orphanedProject.deleted_by_employee_id, orphanedKpi: orphanedKpi.deleted_by_employee_id }));

    // ---- repository 404s ----
    for (const [label, fn] of [
      ["projectRepository.deleteById", () => container.projectRepository.deleteById(randomUUID(), admin.employeeId)],
      ["kpiRepository.deleteById", () => container.kpiRepository.deleteById(randomUUID(), admin.employeeId)],
    ]) {
      try { await fn(); record(`${label} on a missing id`, false, "did not throw"); } catch (e) { check(`${label} on a missing id -> 404`, e.statusCode === 404, `${e.statusCode} ${e.code}`); }
    }
    check("repository updateById/rate on a missing id -> null", (await container.projectRepository.updateById(randomUUID(), { title: "x" })) === null
      && (await container.kpiRepository.updateById(randomUUID(), { title: "x" })) === null
      && (await container.kpiRepository.rate(randomUUID(), { rating: 5, ratedByEmployeeId: admin.employeeId })) === null, "");
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
    const tag = `p8e2e-${randomUUID().slice(0, 8)}`;
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
      // the columns migration 009 adds, so it cannot run on a database without them.
      const { rows: [{ present }] } = await pool.query(
        `SELECT (SELECT count(*) FROM information_schema.columns
                 WHERE table_name IN ('projects', 'kpis') AND column_name = 'deleted_by_employee_id') = 2 AS present`,
      );
      if (!present) throw new Error("Migration 009 is not applied to this database; run `npm run db:migrate` first.");

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
