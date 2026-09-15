import { randomUUID } from "node:crypto";

/**
 * Applies an ImportPlan (from services/firestoreImportService.js) to Postgres, inside one
 * transaction. This is the only file in the importer that touches a database.
 *
 * Resolution strategy per table:
 *   - companies, departments, users, employees, attendance, payroll: a real natural key
 *     already exists (see docs/schema-design.md), so INSERT ... ON CONFLICT ... DO UPDATE
 *     makes re-import idempotent for free.
 *   - projects, kpis: no natural key exists. firestore_import_refs (migration 004) maps a
 *     source (collection, id) to the Postgres row it became, resolved/created here.
 *
 * Every plan step carries a synthetic `key` (e.g. "employees:<sourceId>"). As rows are
 * written, `resolved` accumulates key -> real uuid, so later steps can fill in foreign
 * keys that referenced an earlier step's rows.
 */
export function createFirestoreImportRepository(database) {
  async function upsertCompany(client, resolved, step) {
    const { rows: existing } = await client.query("SELECT id FROM companies LIMIT 1");
    if (existing[0]) {
      resolved.set(step.key, existing[0].id);
      return;
    }
    const { rows } = await client.query(
      "INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id",
      [step.fields.name, step.fields.code],
    );
    resolved.set(step.key, rows[0].id);
  }

  async function upsertDepartment(client, resolved, companyId, step) {
    const { rows } = await client.query(
      `INSERT INTO departments (company_id, name, description, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(name)) WHERE deleted_at IS NULL
       DO UPDATE SET description = EXCLUDED.description, status = EXCLUDED.status
       RETURNING id`,
      [companyId, step.fields.name, step.fields.description, step.fields.status],
    );
    resolved.set(step.key, rows[0].id);
  }

  async function upsertUser(client, resolved, companyId, step) {
    const { rows } = await client.query(
      `INSERT INTO users (company_id, email, role, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) WHERE deleted_at IS NULL
       DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status
       RETURNING id`,
      [companyId, step.fields.email, step.fields.role, step.fields.status],
    );
    resolved.set(step.key, rows[0].id);
  }

  async function upsertEmployee(client, resolved, companyId, step) {
    const userId = resolved.get(step.refs.userKey);
    const departmentId = resolved.get(`departments:${step.refs.departmentId}`);
    const { rows } = await client.query(
      `INSERT INTO employees
         (user_id, company_id, department_id, employee_number, full_name, phone,
          position_title, employment_status, joined_on, basic, allowances)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id)
       DO UPDATE SET department_id = EXCLUDED.department_id,
                     employee_number = EXCLUDED.employee_number,
                     full_name = EXCLUDED.full_name,
                     phone = EXCLUDED.phone,
                     position_title = EXCLUDED.position_title,
                     employment_status = EXCLUDED.employment_status,
                     joined_on = EXCLUDED.joined_on,
                     basic = EXCLUDED.basic,
                     allowances = EXCLUDED.allowances
       RETURNING id`,
      [
        userId, companyId, departmentId, step.fields.employee_number, step.fields.full_name,
        step.fields.phone, step.fields.position_title, step.fields.employment_status,
        step.fields.joined_on, step.fields.basic, step.fields.allowances,
      ],
    );
    resolved.set(step.key, rows[0].id);
  }

  /** Second pass: team_lead_id can reference an employee inserted earlier in this same batch. */
  async function updateEmployeeTeamLead(client, resolved, step) {
    if (!step.refs.teamLeadKey) return;
    const employeeId = resolved.get(step.key);
    const teamLeadId = resolved.get(step.refs.teamLeadKey);
    if (!teamLeadId) return;
    await client.query("UPDATE employees SET team_lead_id = $1 WHERE id = $2", [teamLeadId, employeeId]);
  }

  async function updateDepartmentManager(client, resolved, update) {
    const departmentId = resolved.get(`departments:${update.departmentSourceId}`);
    const managerId = resolved.get(update.managerEmployeeKey);
    if (!departmentId || !managerId) return;
    await client.query(
      "UPDATE departments SET manager_employee_id = $1 WHERE id = $2",
      [managerId, departmentId],
    );
  }

  /** Resolves (or creates) the bookkeeping mapping for a table with no natural key. */
  async function resolveBookkeepingId(client, sourceCollection, sourceId) {
    const { rows } = await client.query(
      "SELECT target_id FROM firestore_import_refs WHERE source_collection = $1 AND source_id = $2",
      [sourceCollection, sourceId],
    );
    if (rows[0]) return { id: rows[0].target_id, isNew: false };
    const id = randomUUID();
    await client.query(
      "INSERT INTO firestore_import_refs (source_collection, source_id, target_id) VALUES ($1, $2, $3)",
      [sourceCollection, sourceId, id],
    );
    return { id, isNew: true };
  }

  async function upsertProject(client, resolved, companyId, step) {
    const { id } = await resolveBookkeepingId(client, "projects", step.sourceId);
    const departmentId = resolved.get(`departments:${step.refs.departmentId}`);
    const teamLeadId = step.refs.teamLeadKey ? resolved.get(step.refs.teamLeadKey) : null;
    await client.query(
      `INSERT INTO projects (id, company_id, department_id, team_lead_id, title, description, start_date, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id)
       DO UPDATE SET department_id = EXCLUDED.department_id,
                     team_lead_id = EXCLUDED.team_lead_id,
                     title = EXCLUDED.title,
                     description = EXCLUDED.description,
                     start_date = EXCLUDED.start_date,
                     due_date = EXCLUDED.due_date,
                     status = EXCLUDED.status`,
      [id, companyId, departmentId, teamLeadId, step.fields.title, step.fields.description,
        step.fields.start_date, step.fields.due_date, step.fields.status],
    );
    resolved.set(step.key, id);
  }

  /** Reconciles project_assignments to exactly the given set for each project. */
  async function reconcileProjectAssignments(client, resolved, projectSteps, assignmentSteps) {
    const byProject = new Map();
    for (const assignment of assignmentSteps) {
      if (!byProject.has(assignment.refs.projectKey)) byProject.set(assignment.refs.projectKey, []);
      byProject.get(assignment.refs.projectKey).push(assignment);
    }
    for (const project of projectSteps) {
      const projectId = resolved.get(project.key);
      const departmentId = resolved.get(`departments:${project.refs.departmentId}`);
      const assignments = byProject.get(project.key) ?? [];
      const employeeIds = assignments
        .map((assignment) => resolved.get(assignment.refs.employeeKey))
        .filter(Boolean);

      await client.query(
        `DELETE FROM project_assignments WHERE project_id = $1 AND employee_id <> ALL($2::uuid[])`,
        [projectId, employeeIds.length ? employeeIds : ["00000000-0000-0000-0000-000000000000"]],
      );
      for (const employeeId of employeeIds) {
        await client.query(
          `INSERT INTO project_assignments (project_id, employee_id, department_id)
           VALUES ($1, $2, $3) ON CONFLICT (project_id, employee_id) DO NOTHING`,
          [projectId, employeeId, departmentId],
        );
      }
    }
  }

  async function upsertKpi(client, resolved, step) {
    const { id } = await resolveBookkeepingId(client, "kpis", step.sourceId);
    const employeeId = resolved.get(step.refs.employeeKey);
    const projectId = step.refs.projectKey ? resolved.get(step.refs.projectKey) : null;
    const ratedByEmployeeId = step.refs.ratedByEmployeeKey ? resolved.get(step.refs.ratedByEmployeeKey) : null;
    await client.query(
      `INSERT INTO kpis (id, project_id, employee_id, title, target, current_value, weight, period, rating, rated_by_employee_id, rated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id)
       DO UPDATE SET project_id = EXCLUDED.project_id,
                     title = EXCLUDED.title,
                     target = EXCLUDED.target,
                     current_value = EXCLUDED.current_value,
                     weight = EXCLUDED.weight,
                     period = EXCLUDED.period,
                     rating = EXCLUDED.rating,
                     rated_by_employee_id = EXCLUDED.rated_by_employee_id,
                     rated_at = EXCLUDED.rated_at`,
      [id, projectId, employeeId, step.fields.title, step.fields.target, step.fields.current_value,
        step.fields.weight, step.fields.period, step.fields.rating, ratedByEmployeeId, step.fields.rated_at],
    );
  }

  async function insertLeave(client, resolved, step) {
    const { id, isNew } = await resolveBookkeepingId(client, "leaves", step.sourceId);
    if (!isNew) return; // leaves have no natural key; once imported, never re-written
    const employeeId = resolved.get(step.refs.employeeKey);
    await client.query(
      `INSERT INTO leaves (id, employee_id, type, start_date, end_date, reason, status,
                            applied_on, decided_by_employee_id, decided_at, decision_recorded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, employeeId, step.fields.type, step.fields.start_date, step.fields.end_date,
        step.fields.reason, step.fields.status, step.fields.applied_on,
        step.fields.decided_by_employee_id, step.fields.decided_at, step.fields.decision_recorded],
    );
  }

  async function upsertAttendance(client, resolved, step) {
    const employeeId = resolved.get(step.refs.employeeKey);
    await client.query(
      `INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (employee_id, work_date) WHERE deleted_at IS NULL
       DO UPDATE SET status = EXCLUDED.status, check_in = EXCLUDED.check_in,
                     check_out = EXCLUDED.check_out, notes = EXCLUDED.notes`,
      [employeeId, step.fields.work_date, step.fields.status, step.fields.check_in,
        step.fields.check_out, step.fields.notes],
    );
  }

  async function upsertPayroll(client, resolved, step) {
    const employeeId = resolved.get(step.refs.employeeKey);
    await client.query(
      `INSERT INTO payroll (employee_id, period_year, period_month, basic, allowances, bonus, deductions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (employee_id, period_year, period_month) WHERE deleted_at IS NULL
       DO UPDATE SET basic = EXCLUDED.basic, allowances = EXCLUDED.allowances,
                     bonus = EXCLUDED.bonus, deductions = EXCLUDED.deductions, status = EXCLUDED.status`,
      [employeeId, step.fields.period_year, step.fields.period_month, step.fields.basic,
        step.fields.allowances, step.fields.bonus, step.fields.deductions, step.fields.status],
    );
  }

  return Object.freeze({
    /**
     * Applies the plan inside one transaction. Throws (and rolls back) on any database
     * error; callers are expected to have already refused on plan.conflicts.length > 0.
     */
    async apply(plan) {
      const client = await database.connect();
      const resolved = new Map();
      try {
        await client.query("BEGIN");

        for (const step of plan.steps.companies) await upsertCompany(client, resolved, step);
        const companyId = resolved.get("companies:singleton");

        for (const step of plan.steps.departments) await upsertDepartment(client, resolved, companyId, step);
        for (const step of plan.steps.users) await upsertUser(client, resolved, companyId, step);
        for (const step of plan.steps.employees) await upsertEmployee(client, resolved, companyId, step);
        for (const step of plan.steps.employees) await updateEmployeeTeamLead(client, resolved, step);
        for (const update of plan.steps.departmentManagerUpdates) await updateDepartmentManager(client, resolved, update);

        for (const step of plan.steps.projects) await upsertProject(client, resolved, companyId, step);
        await reconcileProjectAssignments(client, resolved, plan.steps.projects, plan.steps.projectAssignments);
        for (const step of plan.steps.kpis) await upsertKpi(client, resolved, step);
        for (const step of plan.steps.leaves) await insertLeave(client, resolved, step);
        for (const step of plan.steps.attendance) await upsertAttendance(client, resolved, step);
        for (const step of plan.steps.payroll) await upsertPayroll(client, resolved, step);

        await client.query("COMMIT");
        return { applied: true };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
