import { HttpError } from "../utils/httpError.js";
import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

// target and current_value are cast to float8 on purpose (D29). pg returns numeric as a string
// ("1000.00"), and the frontend does arithmetic on them (progress percentages), which would
// concatenate instead of summing. numeric(14,2) has at most 14 significant digits, which a double
// holds exactly. Shared by reads and write responses so both agree. Same fix as payroll's money
// columns and for the same reason.
const KPI_COLUMNS = `
  kpis.id,
  kpis.project_id,
  kpis.employee_id,
  kpis.title,
  kpis.target::float8 AS target,
  kpis.current_value::float8 AS current_value,
  kpis.weight,
  kpis.period,
  kpis.status,
  kpis.rating,
  kpis.rated_by_employee_id,
  kpis.rated_at,
  kpis.created_at,
  kpis.updated_at
`;

/**
 * kpis.<key> for changes a PATCH may touch. employee_id and project_id are deliberately absent
 * (frozen, D29), as are the rating columns (their own operation) and deleted_*.
 */
const KPI_UPDATE_COLUMNS = Object.freeze(["title", "target", "current_value", "weight", "period", "status"]);

/**
 * Maps a Postgres constraint violation into the same clean HttpError shape the other write
 * repositories use instead of an opaque 500. The two rating bans are database constraints and are
 * deliberately NOT re-implemented anywhere in the service layer (D29); this is where their
 * violations become clean answers. Anything not recognised is rethrown as-is.
 */
function translateWriteError(error) {
  if (error?.code === "23514") { // check_violation
    switch (error.constraint) {
      case "kpis_no_self_rating":
        return new HttpError(403, "self_rating_denied", "You cannot rate your own KPI.");
      case "kpis_legacy_not_rateable":
        return new HttpError(409, "legacy_kpi_not_rateable", "A KPI with no project cannot be rated.");
      case "kpis_rating_range":
        return new HttpError(400, "invalid_rating", "rating must be a whole number from 1 to 10.");
      case "kpis_target_positive":
        return new HttpError(400, "invalid_target", "target must be greater than 0.");
      case "kpis_current_non_negative":
        return new HttpError(400, "invalid_current_value", "current_value cannot be negative.");
      case "kpis_weight_range":
        return new HttpError(400, "invalid_weight", "weight must be a whole number from 1 to 100.");
      default:
        return new HttpError(400, "invalid_request", "This request would create an invalid KPI.");
    }
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "kpis_employee_id_fkey") {
      return new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    if (error.constraint === "kpis_project_id_fkey") {
      return new HttpError(400, "invalid_project", "project_id does not reference an existing project.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "22003") { // numeric_value_out_of_range
    return new HttpError(400, "invalid_amounts", "A KPI amount is too large.");
  }
  return error;
}

async function selectKpiById(client, kpiId) {
  const { rows } = await client.query(
    `SELECT ${KPI_COLUMNS}
     FROM kpis
     WHERE kpis.id = $1 AND kpis.deleted_at IS NULL`,
    [kpiId],
  );
  return rows[0] || null;
}

/**
 * Section 6 gives kpis the same employee-join predicate as leaves/attendance/payroll,
 * joined via kpis.employee_id = employees.id -- deliberately simpler than the old
 * getScopedWorkspace callable, which only surfaced KPIs tied to scoped projects. This is
 * section 6's own explicit simplification (a manager now sees all of their department's
 * KPIs, not only project-linked ones), followed literally rather than re-derived from the
 * callable the way projects' scope is. The WRITE scope is narrower and lives in
 * kpiAuthorizationService.js (D29).
 */
export function createKpiRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${KPI_COLUMNS}
         FROM kpis
         JOIN employees ON employees.id = kpis.employee_id
         WHERE kpis.deleted_at IS NULL AND ${scope.text}
         ORDER BY kpis.created_at DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(kpiId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${KPI_COLUMNS}
         FROM kpis
         JOIN employees ON employees.id = kpis.employee_id
         WHERE kpis.id = $1 AND kpis.deleted_at IS NULL AND ${scope.text}`,
        [kpiId, ...scope.values],
      );
      return rows[0] || null;
    },

    /**
     * The live KPI with everything the write authorization needs (D29): its employee's department
     * and team lead, and -- for a KPI with a project -- the project's department and lead and each
     * assignee's own team lead (an empty array for a legacy KPI). The project is LEFT-joined and
     * not filtered on its own deleted_at, so a KPI whose project has since gone still authorizes.
     * The extra columns are authorization input only; write methods return the plain read shape.
     */
    async findByIdForWrite(kpiId) {
      const { rows } = await database.query(
        `SELECT ${KPI_COLUMNS},
                employees.department_id AS employee_department_id,
                employees.team_lead_id AS employee_team_lead_id,
                projects.department_id AS project_department_id,
                projects.team_lead_id AS project_team_lead_id,
                ARRAY(
                  SELECT assignee.team_lead_id
                  FROM project_assignments
                  JOIN employees AS assignee ON assignee.id = project_assignments.employee_id
                  WHERE project_assignments.project_id = kpis.project_id
                ) AS project_assignee_team_lead_ids
         FROM kpis
         JOIN employees ON employees.id = kpis.employee_id
         LEFT JOIN projects ON projects.id = kpis.project_id
         WHERE kpis.id = $1 AND kpis.deleted_at IS NULL`,
        [kpiId],
      );
      return rows[0] || null;
    },

    /**
     * Inserts a KPI. The employee must be an assignee of a live project (D29, create only). Both
     * rows are locked FOR SHARE inside the transaction, so a concurrent project edit or delete --
     * which takes FOR UPDATE on the same rows before it counts KPIs -- either waits for this KPI
     * to commit and then refuses (the KPI is counted), or commits first and this insert finds the
     * assignment gone. Rating columns are never written here: a new KPI is unrated.
     */
    async create({ project_id, employee_id, title, target, current_value, weight, period, status }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [project] } = await client.query(
          "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR SHARE",
          [project_id],
        );
        if (!project) throw new HttpError(400, "invalid_project", "project_id does not reference an existing project.");

        const { rows: [assignment] } = await client.query(
          "SELECT 1 AS assigned FROM project_assignments WHERE project_id = $1 AND employee_id = $2 FOR SHARE",
          [project_id, employee_id],
        );
        if (!assignment) {
          throw new HttpError(400, "employee_not_assigned", "The employee is not assigned to this project.");
        }

        const { rows: [inserted] } = await client.query(
          `INSERT INTO kpis (project_id, employee_id, title, target, current_value, weight, period, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [project_id, employee_id, title, target, current_value, weight, period, status],
        );

        const created = await selectKpiById(client, inserted.id);
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
     * Applies `changes` in one transaction. Only progress fields: employee_id and project_id are
     * frozen and the rating has its own operation, so none of them is in the whitelist even if
     * smuggled onto `changes`. Returns null if the KPI does not exist.
     */
    async updateById(id, changes) {
      const sets = [];
      const values = [];
      for (const column of KPI_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        values.push(changes[column]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return selectKpiById(database, id);

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        values.push(id);
        const { rows: updatedRows } = await client.query(
          `UPDATE kpis SET ${sets.join(", ")} WHERE id = $${values.length} AND deleted_at IS NULL RETURNING id`,
          values,
        );
        if (updatedRows.length === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const updated = await selectKpiById(client, id);
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
     * Sets the rating (D29). The rater and the time are the server's: `ratedByEmployeeId` is the
     * acting principal and `rated_at` is now(), so a client can never say who rated or when. A
     * re-rating overwrites all three together; the database keeps them consistent
     * (kpis_rating_fields_consistent). Self-rating and rating a legacy KPI are refused by
     * kpis_no_self_rating and kpis_legacy_not_rateable -- not checked here -- and surface through
     * translateWriteError. Returns null if the KPI does not exist.
     */
    async rate(id, { rating, ratedByEmployeeId }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: updatedRows } = await client.query(
          `UPDATE kpis
           SET rating = $2, rated_by_employee_id = $3, rated_at = now()
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id`,
          [id, rating, ratedByEmployeeId],
        );
        if (updatedRows.length === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const rated = await selectKpiById(client, id);
        await client.query("COMMIT");
        return rated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /** Soft-deletes the KPI and records who did it (D29). A KPI holds nothing else in place. */
    async deleteById(id, deletedByEmployeeId) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows } = await client.query(
          `UPDATE kpis
           SET deleted_at = now(), deleted_by_employee_id = $2
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id`,
          [id, deletedByEmployeeId],
        );
        if (rows.length === 0) throw new HttpError(404, "not_found", "KPI not found.");

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
