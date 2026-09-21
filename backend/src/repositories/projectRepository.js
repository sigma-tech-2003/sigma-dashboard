import { buildProjectScopeFilter } from "../services/projectScopeService.js";

const PROJECT_COLUMNS = `
  projects.id,
  projects.company_id,
  projects.department_id,
  projects.team_lead_id,
  projects.title,
  projects.description,
  projects.start_date,
  projects.due_date,
  projects.status,
  projects.created_at,
  projects.updated_at
`;

/**
 * assignedEmployeeIds is aggregated from project_assignments and attached per row, matching
 * Firestore's projects.assignedEmployeeIds[] shape so the parity harness can compare it
 * directly rather than the caller needing a second query.
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
  });
}
