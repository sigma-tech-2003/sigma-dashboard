import { HttpError } from "../utils/httpError.js";
import { buildProjectScopeFilter } from "../services/projectScopeService.js";

// start_date and due_date are formatted in SQL on purpose (D29). pg parses a `date` column into a
// JS Date at server-local midnight, which JSON-serialises a day early on any server east of UTC;
// selecting them as text keeps reads and write responses agreeing on "YYYY-MM-DD". Same fix as
// attendance.work_date and for the same reason.
//
// department_name (D33) is a scalar subquery, not a join, so every query that selects this list keeps
// its FROM and WHERE untouched. Only admin and hr may read the departments list, but a manager, tl or
// employee needs the NAME of the department their projects belong to; a subquery behaves as a LEFT JOIN
// and, like one, does not filter departments.deleted_at.
const PROJECT_COLUMNS = `
  projects.id,
  projects.company_id,
  projects.department_id,
  (SELECT departments.name FROM departments WHERE departments.id = projects.department_id) AS department_name,
  projects.team_lead_id,
  projects.title,
  projects.description,
  to_char(projects.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(projects.due_date, 'YYYY-MM-DD') AS due_date,
  projects.status,
  projects.created_at,
  projects.updated_at
`;

/** projects.<key> for scalar changes a PATCH may touch. Timestamps and deleted_* are never writable. */
const PROJECT_UPDATE_COLUMNS = Object.freeze([
  "department_id", "team_lead_id", "title", "description", "start_date", "due_date", "status",
]);

/**
 * assignedEmployeeIds is aggregated from project_assignments and attached per row, matching
 * Firestore's projects.assignedEmployeeIds[] shape so the parity harness can compare it
 * directly rather than the caller needing a second query. Write responses reuse this exact
 * shape, so a project reads the same whether it was just written or fetched.
 */
async function attachAssignedEmployeeIds(database, projects) {
  if (projects.length === 0) return projects;
  const projectIds = projects.map((project) => project.id);
  const { rows } = await database.query(
    `SELECT project_id, employee_id FROM project_assignments WHERE project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  const byProject = new Map();
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push(row.employee_id);
  }
  return projects.map((project) => ({
    ...project,
    assignedEmployeeIds: byProject.get(project.id) ?? [],
  }));
}

async function selectProjectWithAssignments(client, projectId) {
  const { rows } = await client.query(
    `SELECT ${PROJECT_COLUMNS}
     FROM projects
     WHERE projects.id = $1 AND projects.deleted_at IS NULL`,
    [projectId],
  );
  if (!rows[0]) return null;
  const [withAssignments] = await attachAssignedEmployeeIds(client, rows);
  return withAssignments;
}

/**
 * One statement, so the project's department is carried onto every row: the two composite
 * foreign keys on project_assignments are what force project and assignee into the same
 * department (docs/schema-design.md 4.6).
 */
async function insertAssignments(client, projectId, departmentId, employeeIds) {
  if (employeeIds.length === 0) return;
  await client.query(
    `INSERT INTO project_assignments (project_id, employee_id, department_id)
     SELECT $1::uuid, assignee, $3::uuid FROM unnest($2::uuid[]) AS assignee`,
    [projectId, employeeIds, departmentId],
  );
}

/** Live KPIs only: a soft-deleted KPI no longer holds anything in place. */
async function countLiveKpis(client, projectId, employeeIds = null) {
  const { rows: [{ count }] } = employeeIds
    ? await client.query(
      `SELECT count(*)::int AS count FROM kpis
       WHERE project_id = $1 AND employee_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [projectId, employeeIds],
    )
    : await client.query(
      "SELECT count(*)::int AS count FROM kpis WHERE project_id = $1 AND deleted_at IS NULL",
      [projectId],
    );
  return count;
}

/**
 * Maps a Postgres constraint violation into the same clean HttpError shape the other write
 * repositories use instead of an opaque 500. Anything not recognised -- including an HttpError
 * this repository threw itself -- is rethrown as-is.
 */
function translateWriteError(error) {
  if (error?.code === "23505") { // unique_violation
    if (error.constraint === "project_assignments_pkey") {
      return new HttpError(400, "invalid_assignee", "An employee cannot be assigned to a project more than once.");
    }
    return new HttpError(409, "conflict", "This record already exists.");
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "projects_team_lead_department_foreign_key") {
      return new HttpError(400, "invalid_team_lead", "team_lead_id must reference an employee in the project's department.");
    }
    if (error.constraint === "projects_department_company_foreign_key") {
      return new HttpError(400, "invalid_department", "department_id does not reference an existing department.");
    }
    if (error.constraint === "project_assignments_employee_department_foreign_key") {
      return new HttpError(400, "invalid_assignee", "Every assigned employee must exist and work in the project's department.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "23514") { // check_violation
    if (error.constraint === "projects_dates_ordered") {
      return new HttpError(400, "invalid_dates", "due_date must be on or after start_date.");
    }
    return new HttpError(400, "invalid_request", "This request would create an invalid project.");
  }
  return error;
}

export function createProjectRepository(database) {
  return Object.freeze({
    /** See services/projectScopeService.js for why this cannot reuse buildEmployeeScopeFilter. */
    async listForPrincipal(principal) {
      const scope = buildProjectScopeFilter(principal, { alias: "projects" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects
         WHERE projects.deleted_at IS NULL AND ${scope.text}
         ORDER BY projects.title`,
        scope.values,
      );
      return attachAssignedEmployeeIds(database, rows);
    },

    async findByIdForPrincipal(projectId, principal) {
      const scope = buildProjectScopeFilter(principal, { alias: "projects", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects
         WHERE projects.id = $1 AND projects.deleted_at IS NULL AND ${scope.text}`,
        [projectId, ...scope.values],
      );
      if (!rows[0]) return null;
      const [withAssignments] = await attachAssignedEmployeeIds(database, rows);
      return withAssignments;
    },

    /**
     * The live project, unscoped, with each assignee's own team_lead_id -- exactly what the write
     * authorization needs (D29): the project's department and lead, and whether any assignee
     * reports to a given team lead. `assignees` is authorization input; write methods return the
     * plain read shape.
     */
    async findByIdForWrite(projectId) {
      const { rows } = await database.query(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects
         WHERE projects.id = $1 AND projects.deleted_at IS NULL`,
        [projectId],
      );
      if (!rows[0]) return null;

      const { rows: assignees } = await database.query(
        `SELECT employees.id, employees.team_lead_id
         FROM project_assignments
         JOIN employees ON employees.id = project_assignments.employee_id
         WHERE project_assignments.project_id = $1`,
        [projectId],
      );
      return { ...rows[0], assignees };
    },

    /**
     * Inserts the project and its assignments in one transaction. The company comes from the live
     * department row, which is what the composite (department_id, company_id) foreign key checks.
     * created_at/updated_at are column defaults and never written (D29).
     */
    async create({ department_id, team_lead_id, title, description, start_date, due_date, status, assigned_employee_ids }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [department] } = await client.query(
          "SELECT company_id FROM departments WHERE id = $1 AND deleted_at IS NULL",
          [department_id],
        );
        if (!department) {
          throw new HttpError(400, "invalid_department", "department_id does not reference an existing department.");
        }

        const { rows: [inserted] } = await client.query(
          `INSERT INTO projects (company_id, department_id, team_lead_id, title, description, start_date, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [department.company_id, department_id, team_lead_id ?? null, title, description, start_date, due_date, status],
        );
        await insertAssignments(client, inserted.id, department_id, assigned_employee_ids);

        const created = await selectProjectWithAssignments(client, inserted.id);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Applies `changes` in one transaction. `assigned_employee_ids`, when present, REPLACES the set
     * atomically (D29): rows are deleted and inserted by difference, never wholesale, so an
     * unchanged assignee keeps their row and `assigned_at`. Returns null if the project does not
     * exist.
     *
     * Removing an assignee who still has live KPIs on this project is refused with 409
     * assignee_has_kpis and the count (D29, the D26 pattern: soft-deleted rows make RESTRICT
     * inert, so this is a service obligation). The removed assignment rows are locked FIRST and the
     * KPIs counted AFTER: a concurrent KPI create holds a FOR SHARE lock on the assignment row, so
     * either it commits before the lock is granted (and is counted) or it waits and then finds the
     * assignment gone.
     *
     * Changing the department removes every current assignee and inserts the new set under the new
     * department, in that order -- the composite foreign keys forbid any other. The schema already
     * requires the caller to send the lead and the assignees with a department change.
     */
    async updateById(id, changes) {
      const { assigned_employee_ids: nextAssigneeIds, ...scalars } = changes;
      const sets = [];
      const values = [];
      for (const column of PROJECT_UPDATE_COLUMNS) {
        if (!Object.hasOwn(scalars, column)) continue;
        values.push(scalars[column]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0 && !nextAssigneeIds) return selectProjectWithAssignments(database, id);

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [current] } = await client.query(
          "SELECT department_id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
          [id],
        );
        if (!current) {
          await client.query("ROLLBACK");
          return null;
        }

        const nextDepartmentId = scalars.department_id ?? current.department_id;
        const changingDepartment = nextDepartmentId !== current.department_id;
        if (changingDepartment && !nextAssigneeIds) {
          // The schema already requires this; refusing here keeps the repository safe on its own,
          // because every current assignment row would otherwise be left under the old department.
          throw new HttpError(400, "invalid_request", "Changing a project's department requires assigned_employee_ids.");
        }

        let toRemove = [];
        let toAdd = [];
        if (nextAssigneeIds || changingDepartment) {
          const { rows: currentRows } = await client.query(
            "SELECT employee_id FROM project_assignments WHERE project_id = $1",
            [id],
          );
          const currentIds = currentRows.map((row) => row.employee_id);
          const nextIds = nextAssigneeIds ?? [];

          if (changingDepartment) {
            toRemove = currentIds;
            toAdd = nextIds;
          } else {
            const nextSet = new Set(nextIds);
            const currentSet = new Set(currentIds);
            toRemove = currentIds.filter((employeeId) => !nextSet.has(employeeId));
            toAdd = nextIds.filter((employeeId) => !currentSet.has(employeeId));
          }

          if (toRemove.length > 0) {
            // Lock first, count second -- see the doc comment above.
            await client.query(
              `SELECT employee_id FROM project_assignments
               WHERE project_id = $1 AND employee_id = ANY($2::uuid[]) FOR UPDATE`,
              [id, toRemove],
            );
            const liveKpis = await countLiveKpis(client, id, toRemove);
            if (liveKpis > 0) {
              throw new HttpError(
                409,
                "assignee_has_kpis",
                `An assignee being removed still has ${liveKpis} KPI(s) on this project; delete or move them first.`,
                { live_kpi_count: liveKpis },
              );
            }
            await client.query(
              "DELETE FROM project_assignments WHERE project_id = $1 AND employee_id = ANY($2::uuid[])",
              [id, toRemove],
            );
          }
        }

        if (sets.length > 0) {
          values.push(id);
          await client.query(
            `UPDATE projects SET ${sets.join(", ")} WHERE id = $${values.length} AND deleted_at IS NULL`,
            values,
          );
        } else {
          // An assignment-only change still changes the project: touch the row so the
          // set_updated_at trigger advances updated_at.
          await client.query("UPDATE projects SET title = title WHERE id = $1 AND deleted_at IS NULL", [id]);
        }

        await insertAssignments(client, id, nextDepartmentId, toAdd);

        const updated = await selectProjectWithAssignments(client, id);
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Soft-deletes the project and records who did it (D29). Refused with 409 project_has_kpis and
     * the count if any live KPI still belongs to it: projects are soft-deleted, so kpis.project_id's
     * ON DELETE RESTRICT never fires and this check is the only thing standing in for it. The row
     * is locked first so a KPI created concurrently (which takes a FOR SHARE lock on the project)
     * is either counted or refused. Assignment rows are left alone; they are hidden with the
     * project.
     */
    async deleteById(id, deletedByEmployeeId) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [target] } = await client.query(
          "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
          [id],
        );
        if (!target) throw new HttpError(404, "not_found", "Project not found.");

        const liveKpis = await countLiveKpis(client, id);
        if (liveKpis > 0) {
          throw new HttpError(
            409,
            "project_has_kpis",
            `This project still has ${liveKpis} KPI(s); delete or move them before deleting it.`,
            { live_kpi_count: liveKpis },
          );
        }

        await client.query(
          "UPDATE projects SET deleted_at = now(), deleted_by_employee_id = $2 WHERE id = $1",
          [id, deletedByEmployeeId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },
  });
}
