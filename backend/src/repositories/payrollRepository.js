import { HttpError } from "../utils/httpError.js";
import { buildPayrollScopeFilter } from "../services/employeeScopeService.js";

// The money columns are cast to float8 on purpose (D28). pg returns numeric as a string
// ("50000.00"), and the frontend adds these values (p.basic + p.allowances + p.bonus), which
// would concatenate instead of summing. numeric(12,2) has at most 12 significant digits, which a
// double holds exactly, so nothing is lost. Shared by reads and write responses so both agree.
// Payroll-only: employees.basic/allowances have the same string behaviour and are a separate fix.
const PAYROLL_COLUMNS = `
  payroll.id,
  payroll.employee_id,
  payroll.period_year,
  payroll.period_month,
  payroll.basic::float8 AS basic,
  payroll.allowances::float8 AS allowances,
  payroll.bonus::float8 AS bonus,
  payroll.deductions::float8 AS deductions,
  payroll.gross::float8 AS gross,
  payroll.tax::float8 AS tax,
  payroll.net::float8 AS net,
  payroll.status,
  payroll.created_at,
  payroll.updated_at
`;

/**
 * payroll.<key> for changes a PATCH may touch. gross/tax/net are generated columns (writing
 * them is a Postgres error), and timestamps and deleted_* are never writable here.
 */
const PAYROLL_UPDATE_COLUMNS = Object.freeze([
  "employee_id", "period_year", "period_month", "basic", "allowances", "bonus", "deductions", "status",
]);

/**
 * The id of the live row that occupies the employee/period a write was aiming at, so a 409 can
 * tell the caller which record to look at instead (D28, mirroring D9). employeeId/year/month may
 * be null on an update that did not change them -- they then default to the row being updated
 * (`excludeId`), which is also excluded from the match. Runs on the pool, after ROLLBACK: the
 * failed transaction is aborted and cannot run another query.
 */
async function findConflictingId(database, { employeeId = null, periodYear = null, periodMonth = null, excludeId = null }) {
  const { rows } = await database.query(
    `SELECT conflicting.id
     FROM payroll AS conflicting
     WHERE conflicting.deleted_at IS NULL
       AND conflicting.employee_id = COALESCE($1::uuid, (SELECT employee_id FROM payroll WHERE id = $4::uuid))
       AND conflicting.period_year = COALESCE($2::integer, (SELECT period_year FROM payroll WHERE id = $4::uuid))
       AND conflicting.period_month = COALESCE($3::integer, (SELECT period_month FROM payroll WHERE id = $4::uuid))
       AND ($4::uuid IS NULL OR conflicting.id <> $4::uuid)`,
    [employeeId, periodYear, periodMonth, excludeId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Maps a Postgres constraint violation into the same clean HttpError shape the other write
 * repositories use instead of an opaque 500. Anything not recognised is rethrown as-is. Async
 * only because the duplicate-period 409 looks up the occupying record's id.
 */
async function translateWriteError(error, database, conflictTarget) {
  if (error?.code === "23505") { // unique_violation
    if (error.constraint === "payroll_employee_period_unique") {
      const existingId = await findConflictingId(database, conflictTarget).catch(() => null);
      return new HttpError(
        409,
        "payroll_already_recorded",
        "A payroll record already exists for this employee and period.",
        existingId ? { existing_id: existingId } : undefined,
      );
    }
    return new HttpError(409, "conflict", "This record already exists.");
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "payroll_employee_id_fkey") {
      return new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "23514") { // check_violation
    if (error.constraint === "payroll_year_range" || error.constraint === "payroll_month_range") {
      return new HttpError(400, "invalid_period", "period_year must be 1-9999 and period_month must be 1-12.");
    }
    if (error.constraint === "payroll_amounts_non_negative") {
      return new HttpError(400, "invalid_amounts", "Payroll amounts cannot be negative.");
    }
    return new HttpError(400, "invalid_request", "This request would create an invalid payroll record.");
  }
  if (error?.code === "22003") { // numeric_value_out_of_range
    return new HttpError(400, "invalid_amounts", "A payroll amount is too large.");
  }
  return error;
}

async function selectPayrollById(client, payrollId) {
  const { rows } = await client.query(
    `SELECT ${PAYROLL_COLUMNS}
     FROM payroll
     WHERE payroll.id = $1 AND payroll.deleted_at IS NULL`,
    [payrollId],
  );
  return rows[0] || null;
}

/**
 * Uses buildPayrollScopeFilter, not buildEmployeeScopeFilter -- manager/tl are denied
 * (documented exception to section 6, see employeeScopeService.js), so no join to
 * employees is needed at all: payroll.employee_id is already a direct column.
 */
export function createPayrollRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildPayrollScopeFilter(principal, { alias: "payroll" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${PAYROLL_COLUMNS}
         FROM payroll
         WHERE payroll.deleted_at IS NULL AND ${scope.text}
         ORDER BY payroll.period_year DESC, payroll.period_month DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(payrollId, principal) {
      const scope = buildPayrollScopeFilter(principal, { alias: "payroll", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${PAYROLL_COLUMNS}
         FROM payroll
         WHERE payroll.id = $1 AND payroll.deleted_at IS NULL AND ${scope.text}`,
        [payrollId, ...scope.values],
      );
      return rows[0] || null;
    },

    /**
     * The live record, unscoped, for the write path's status check (draft vs processed). Writers
     * are company-wide (admin/hr), so there is no scope to apply.
     */
    async findById(payrollId) {
      return selectPayrollById(database, payrollId);
    },

    /**
     * Inserts a record. gross/tax/net are generated and created_at/updated_at are column
     * defaults, so none of them is ever written (D28). A second live record for the same
     * employee and period surfaces as 409 payroll_already_recorded carrying the existing id.
     */
    async create({ employee_id, period_year, period_month, basic, allowances, bonus, deductions, status }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [inserted] } = await client.query(
          `INSERT INTO payroll (employee_id, period_year, period_month, basic, allowances, bonus, deductions, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [employee_id, period_year, period_month, basic, allowances, bonus, deductions, status],
        );

        const created = await selectPayrollById(client, inserted.id);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw await translateWriteError(error, database, {
          employeeId: employee_id, periodYear: period_year, periodMonth: period_month,
        });
      } finally {
        client.release();
      }
    },

    /**
     * Applies `changes` to a DRAFT in one transaction. Processed records are immutable (D28), and
     * the UPDATE is guarded on status = 'draft' so that holds atomically, not just because the
     * service read the status a moment earlier. Returns null if the record does not exist (or is
     * deleted); throws 409 payroll_not_editable if it exists but is processed. A change that
     * moves the draft onto an occupied employee and period gets the same 409 as create.
     */
    async updateById(id, changes) {
      const sets = [];
      const values = [];
      for (const column of PAYROLL_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        values.push(changes[column]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return selectPayrollById(database, id);

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        values.push(id);
        const { rows: updatedRows } = await client.query(
          `UPDATE payroll SET ${sets.join(", ")}
           WHERE id = $${values.length} AND deleted_at IS NULL AND status = 'draft'
           RETURNING id`,
          values,
        );

        if (updatedRows.length === 0) {
          // Either there is no such record, or it is no longer a draft.
          const existing = await selectPayrollById(client, id);
          await client.query("ROLLBACK");
          if (existing) {
            throw new HttpError(
              409,
              "payroll_not_editable",
              "A processed payroll record cannot be changed; delete it and process a new one.",
            );
          }
          return null;
        }

        const updated = await selectPayrollById(client, id);
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        await client.query("ROLLBACK").catch(() => {});
        throw await translateWriteError(error, database, {
          employeeId: changes.employee_id ?? null,
          periodYear: changes.period_year ?? null,
          periodMonth: changes.period_month ?? null,
          excludeId: id,
        });
      } finally {
        client.release();
      }
    },

    /**
     * Soft-deletes the record, any status, and records who did it (D28). There is no hard-delete
     * path. payroll_employee_period_unique is partial on deleted_at IS NULL, so the freed period
     * can be processed again -- which is the correction workflow for a processed record.
     */
    async deleteById(id, deletedByEmployeeId) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows } = await client.query(
          `UPDATE payroll
           SET deleted_at = now(), deleted_by_employee_id = $2
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id`,
          [id, deletedByEmployeeId],
        );
        if (rows.length === 0) throw new HttpError(404, "not_found", "Payroll record not found.");

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
