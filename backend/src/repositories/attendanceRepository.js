import { HttpError } from "../utils/httpError.js";
import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

// work_date and the two times are formatted in SQL on purpose. pg parses a `date` column into a
// JS Date at server-local midnight, which JSON-serialises a day early on any server east of UTC
// (2026-10-03 on a UTC+5 host becomes "2026-10-02T19:00:00.000Z"). Selecting them as text keeps
// reads and write responses agreeing on "YYYY-MM-DD" and "HH:MM" (D27's wire format).
const ATTENDANCE_COLUMNS = `
  attendance.id,
  attendance.employee_id,
  to_char(attendance.work_date, 'YYYY-MM-DD') AS work_date,
  attendance.status,
  to_char(attendance.check_in, 'HH24:MI') AS check_in,
  to_char(attendance.check_out, 'HH24:MI') AS check_out,
  attendance.notes,
  attendance.created_at,
  attendance.updated_at
`;

/** attendance.<key> for changes a PATCH may touch. Timestamps and deleted_* are never writable. */
const ATTENDANCE_UPDATE_COLUMNS = Object.freeze([
  "employee_id", "work_date", "status", "check_in", "check_out", "notes",
]);

/**
 * The id of the live row that occupies the employee/day a write was aiming at, so a 409 can
 * tell the caller which record to PATCH instead (D9). `employeeId`/`workDate` may be null on
 * an update that did not change them -- they then default to the row being updated
 * (`excludeId`), which is also excluded from the match. Runs on the pool, after ROLLBACK: the
 * failed transaction is aborted and cannot run another query.
 */
async function findConflictingId(database, { employeeId = null, workDate = null, excludeId = null }) {
  const { rows } = await database.query(
    `SELECT conflicting.id
     FROM attendance AS conflicting
     WHERE conflicting.deleted_at IS NULL
       AND conflicting.employee_id = COALESCE($1::uuid, (SELECT employee_id FROM attendance WHERE id = $3::uuid))
       AND conflicting.work_date = COALESCE($2::date, (SELECT work_date FROM attendance WHERE id = $3::uuid))
       AND ($3::uuid IS NULL OR conflicting.id <> $3::uuid)`,
    [employeeId, workDate, excludeId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Maps a Postgres constraint violation into the same clean HttpError shape the employee and
 * department repositories use instead of an opaque 500. Anything not recognised is rethrown
 * as-is. Async only because the duplicate-day 409 looks up the occupying record's id.
 */
async function translateWriteError(error, database, conflictTarget) {
  if (error?.code === "23505") { // unique_violation
    if (error.constraint === "attendance_employee_date_unique") {
      const existingId = await findConflictingId(database, conflictTarget).catch(() => null);
      return new HttpError(
        409,
        "attendance_already_recorded",
        "Attendance is already recorded for this employee on this date.",
        existingId ? { existing_id: existingId } : undefined,
      );
    }
    return new HttpError(409, "conflict", "This record already exists.");
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "attendance_employee_id_fkey") {
      return new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "23514") { // check_violation
    if (error.constraint === "attendance_times_ordered") {
      return new HttpError(400, "invalid_times", "check_out must be later than check_in.");
    }
    if (error.constraint === "attendance_absent_has_no_times") {
      return new HttpError(
        400,
        "invalid_times",
        "Absent and leave records cannot have a check-in or check-out time.",
      );
    }
    return new HttpError(400, "invalid_request", "This request would create an invalid attendance record.");
  }
  return error;
}

async function selectAttendanceById(client, attendanceId) {
  const { rows } = await client.query(
    `SELECT ${ATTENDANCE_COLUMNS}
     FROM attendance
     WHERE attendance.id = $1 AND attendance.deleted_at IS NULL`,
    [attendanceId],
  );
  return rows[0] || null;
}

export function createAttendanceRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${ATTENDANCE_COLUMNS}
         FROM attendance
         JOIN employees ON employees.id = attendance.employee_id
         WHERE attendance.deleted_at IS NULL AND ${scope.text}
         ORDER BY attendance.work_date DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(attendanceId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${ATTENDANCE_COLUMNS}
         FROM attendance
         JOIN employees ON employees.id = attendance.employee_id
         WHERE attendance.id = $1 AND attendance.deleted_at IS NULL AND ${scope.text}`,
        [attendanceId, ...scope.values],
      );
      return rows[0] || null;
    },

    /**
     * The live record plus its employee's department_id, for the write authorization checks.
     * Deliberately NOT filtered on employees.deleted_at: a manager must still be scope-checked
     * (and an admin still able to correct) a record whose employee has since been deleted --
     * the row's department_id survives the soft delete. The extra column is authorization
     * input only; write methods return the plain ATTENDANCE_COLUMNS shape.
     */
    async findById(attendanceId) {
      const { rows } = await database.query(
        `SELECT ${ATTENDANCE_COLUMNS}, employees.department_id AS employee_department_id
         FROM attendance
         JOIN employees ON employees.id = attendance.employee_id
         WHERE attendance.id = $1 AND attendance.deleted_at IS NULL`,
        [attendanceId],
      );
      return rows[0] || null;
    },

    /**
     * Inserts a record. created_at/updated_at are never supplied -- the column defaults and
     * attendance_set_updated_at own them (D27). A second live record for the same employee and
     * day surfaces as 409 attendance_already_recorded carrying the existing id (D9).
     */
    async create({ employee_id, work_date, status, check_in, check_out, notes }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [inserted] } = await client.query(
          `INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [employee_id, work_date, status, check_in ?? null, check_out ?? null, notes ?? null],
        );

        const created = await selectAttendanceById(client, inserted.id);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw await translateWriteError(error, database, { employeeId: employee_id, workDate: work_date });
      } finally {
        client.release();
      }
    },

    /**
     * Applies `changes` in one transaction. Returns null if the record does not exist (or is
     * already soft-deleted). A change that moves the record onto an occupied employee and day
     * gets the same 409 as create.
     */
    async updateById(id, changes) {
      const sets = [];
      const values = [];
      for (const column of ATTENDANCE_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        values.push(changes[column]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return selectAttendanceById(database, id);

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        values.push(id);
        await client.query(
          `UPDATE attendance SET ${sets.join(", ")} WHERE id = $${values.length} AND deleted_at IS NULL`,
          values,
        );

        const updated = await selectAttendanceById(client, id);
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw await translateWriteError(error, database, {
          employeeId: changes.employee_id ?? null,
          workDate: changes.work_date ?? null,
          excludeId: id,
        });
      } finally {
        client.release();
      }
    },

    /**
     * Soft-deletes the record and records who did it (D27). attendance_employee_date_unique is
     * partial on deleted_at IS NULL, so the freed day can be marked again.
     */
    async deleteById(id, deletedByEmployeeId) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows } = await client.query(
          `UPDATE attendance
           SET deleted_at = now(), deleted_by_employee_id = $2
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id`,
          [id, deletedByEmployeeId],
        );
        if (rows.length === 0) throw new HttpError(404, "not_found", "Attendance record not found.");

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw await translateWriteError(error, database, {});
      } finally {
        client.release();
      }
    },
  });
}
