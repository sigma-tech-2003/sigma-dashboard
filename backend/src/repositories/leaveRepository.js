import { HttpError } from "../utils/httpError.js";
import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

// start_date, end_date and applied_on are formatted in SQL on purpose (D31). pg parses a `date`
// column into a JS Date at server-local midnight, which JSON-serialises a day early on any server
// east of UTC; selecting them as text keeps reads and write responses agreeing on "YYYY-MM-DD".
// Same fix as attendance.work_date and the project dates, for the same reason.
const LEAVE_COLUMNS = `
  leaves.id,
  leaves.employee_id,
  leaves.type,
  to_char(leaves.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(leaves.end_date, 'YYYY-MM-DD') AS end_date,
  leaves.days,
  leaves.reason,
  leaves.status,
  to_char(leaves.applied_on, 'YYYY-MM-DD') AS applied_on,
  leaves.decided_by_employee_id,
  leaves.decided_at,
  leaves.decision_recorded,
  leaves.created_at,
  leaves.updated_at
`;

/**
 * Days taken by one employee in one calendar year, per leave type (D40), from employee_leave_usage as
 * migration 011 restored it: approved leave only, each leave attributed whole to the year it STARTS in.
 * `days_used` is sum(integer), which is bigint, which pg returns as a string; the cast makes it a number.
 */
const DAYS_TAKEN_SQL = `
  SELECT type::text AS type, days_used::int AS days_used
  FROM employee_leave_usage
  WHERE employee_id = $1 AND leave_year = $2::int
`;

/**
 * Maps a Postgres constraint violation into the same clean HttpError shape the other write
 * repositories use instead of an opaque 500. leaves_no_self_approval is a database constraint and
 * is deliberately NOT re-implemented anywhere (D8, D31, D40): a decision by the leave's own employee
 * reaches it and comes back here as a clean 403. Anything not recognised -- including an HttpError
 * this repository or a service's validate callback threw -- is rethrown as-is.
 */
function translateWriteError(error) {
  if (error?.code === "23514") { // check_violation
    switch (error.constraint) {
      case "leaves_no_self_approval":
        return new HttpError(403, "self_approval_denied", "You cannot decide your own leave request.");
      case "leaves_dates_ordered":
        return new HttpError(400, "invalid_dates", "end_date must be on or after start_date.");
      default:
        return new HttpError(400, "invalid_request", "This request would create an invalid leave record.");
    }
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "leaves_employee_id_fkey") {
      return new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  return error;
}

async function selectLeaveById(client, leaveId) {
  const { rows } = await client.query(
    `SELECT ${LEAVE_COLUMNS}
     FROM leaves
     WHERE leaves.id = $1 AND leaves.deleted_at IS NULL`,
    [leaveId],
  );
  return rows[0] || null;
}

export function createLeaveRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${LEAVE_COLUMNS}
         FROM leaves
         JOIN employees ON employees.id = leaves.employee_id
         WHERE leaves.deleted_at IS NULL AND ${scope.text}
         ORDER BY leaves.start_date DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(leaveId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${LEAVE_COLUMNS}
         FROM leaves
         JOIN employees ON employees.id = leaves.employee_id
         WHERE leaves.id = $1 AND leaves.deleted_at IS NULL AND ${scope.text}`,
        [leaveId, ...scope.values],
      );
      return rows[0] || null;
    },

    /**
     * The live leave plus its employee's department and team lead, which is exactly what deciding
     * and deleting need to authorize. Deliberately NOT filtered on employees.deleted_at, so a leave
     * whose employee has since been deleted is still decidable by an admin and removable. The extra
     * columns are authorization input only; write methods return the plain read shape.
     */
    async findByIdForWrite(leaveId) {
      const { rows } = await database.query(
        `SELECT ${LEAVE_COLUMNS},
                employees.department_id AS employee_department_id,
                employees.team_lead_id AS employee_team_lead_id
         FROM leaves
         JOIN employees ON employees.id = leaves.employee_id
         WHERE leaves.id = $1 AND leaves.deleted_at IS NULL`,
        [leaveId],
      );
      return rows[0] || null;
    },

    /**
     * Inserts a pending leave in one transaction, after the one check D31 and D40 leave standing: the
     * request must not overlap the employee's own pending or approved leave. The applicant's
     * employee row is locked FOR NO KEY UPDATE first: that serialises concurrent applies for the
     * SAME employee -- so two requests for the same dates cannot both read "no overlap" and both go
     * in -- without blocking other tables' foreign-key checks on that employee, which only take KEY
     * SHARE. The overlap read happens under that lock. (There is no balance check any more: D40.)
     *
     * `validate({ overlapping })` is supplied by the service and may throw an HttpError to refuse
     * the request; the business rule stays there and this method does all the SQL. `overlapping` is
     * the employee's own pending/approved leaves that intersect the requested dates.
     *
     * status, days and every decision column are never written: the column defaults give a pending
     * leave, `days` is generated, and nothing here can decide one.
     */
    async create({ employee_id, type, start_date, end_date, reason, applied_on }, validate) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [employee] } = await client.query(
          `SELECT id
           FROM employees
           WHERE id = $1 AND deleted_at IS NULL
           FOR NO KEY UPDATE`,
          [employee_id],
        );
        if (!employee) throw new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");

        const { rows: overlapping } = await client.query(
          `SELECT id
           FROM leaves
           WHERE employee_id = $1
             AND deleted_at IS NULL
             AND status IN ('pending', 'approved')
             AND start_date <= $3::date
             AND end_date >= $2::date
           ORDER BY start_date
           LIMIT 1`,
          [employee_id, start_date, end_date],
        );

        await validate({ overlapping });

        const { rows: [inserted] } = await client.query(
          `INSERT INTO leaves (employee_id, type, start_date, end_date, reason, applied_on)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [employee_id, type, start_date, end_date, reason, applied_on],
        );

        const created = await selectLeaveById(client, inserted.id);
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
     * Approves or rejects a PENDING leave and records who decided and when. The UPDATE is guarded
     * on status = 'pending', so a decided leave is immutable atomically, not just because the
     * service read the status a moment earlier (D31, as in Firestore). Returns null if the leave
     * does not exist (or is deleted); throws 409 leave_already_decided if it exists but is no
     * longer pending.
     *
     * decided_by_employee_id and decided_at are always written together, which is what
     * leaves_decision_consistent requires; decision_recorded is never written, so the column default
     * (true) stands -- only the importer's pre-existing decisions are false (migration 003).
     */
    async decide(id, { status, decidedByEmployeeId }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: updatedRows } = await client.query(
          `UPDATE leaves
           SET status = $2, decided_by_employee_id = $3, decided_at = now()
           WHERE id = $1 AND deleted_at IS NULL AND status = 'pending'
           RETURNING id`,
          [id, status, decidedByEmployeeId],
        );

        if (updatedRows.length === 0) {
          // Either there is no such leave, or it has already been decided.
          const existing = await selectLeaveById(client, id);
          await client.query("ROLLBACK");
          if (existing) {
            throw new HttpError(409, "leave_already_decided", "This leave request has already been decided.");
          }
          return null;
        }

        const decided = await selectLeaveById(client, id);
        await client.query("COMMIT");
        return decided;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Soft-deletes the leave and records who did it (D31). With `pendingOnly` the UPDATE is guarded
     * on status = 'pending' -- the employee's own cancellation -- so a leave decided between the
     * service's read and this write is refused (409 leave_already_decided) rather than cancelled.
     * Without it (admin/hr correcting any status) there is no status condition. A deleted leave
     * never counts against a balance (section 8 item 7). Throws 404 if the leave does not exist.
     */
    async deleteById(id, deletedByEmployeeId, { pendingOnly = false } = {}) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const guard = pendingOnly ? " AND status = 'pending'" : "";
        const { rows } = await client.query(
          `UPDATE leaves
           SET deleted_at = now(), deleted_by_employee_id = $2
           WHERE id = $1 AND deleted_at IS NULL${guard}
           RETURNING id`,
          [id, deletedByEmployeeId],
        );

        if (rows.length === 0) {
          const existing = pendingOnly ? await selectLeaveById(client, id) : null;
          await client.query("ROLLBACK");
          if (existing) {
            throw new HttpError(409, "leave_already_decided", "A decided leave request cannot be cancelled.");
          }
          throw new HttpError(404, "not_found", "Leave request not found.");
        }

        await client.query("COMMIT");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Days taken (D40): one `{ type, days_used }` row per leave type the employee has approved leave in
     * for the given calendar year, or an empty array if none. A leave counts toward the year it
     * STARTS in. Returns null if the employee does not exist, so the caller can answer 404.
     */
    async daysTaken(employeeId, year) {
      const { rows: [employee] } = await database.query(
        "SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL",
        [employeeId],
      );
      if (!employee) return null;

      const { rows } = await database.query(DAYS_TAKEN_SQL, [employeeId, year]);
      return rows;
    },
  });
}
