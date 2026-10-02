import { HttpError } from "../utils/httpError.js";
import { todayInTimeZone } from "../utils/companyDate.js";
import {
  assertCanReattributeAttendance,
  assertCanWriteAttendance,
  assertCanWriteAttendanceFor,
} from "./attendanceAuthorizationService.js";

/**
 * Orchestrates attendance create/update/delete (D9, D27): authorization, the two rules the
 * database deliberately does not hold -- no future dates, and the referenced employee must be
 * active -- then the repository. Which roles may write, and over whom, lives entirely in
 * attendanceAuthorizationService.js.
 *
 * Timestamps are never touched here: created_at/updated_at are server-set (the column defaults
 * and the set_updated_at trigger), which is why Firestore's "updatedAt is today" checks have no
 * counterpart in this service.
 *
 * @param {object} dependencies
 * @param {string} dependencies.timeZone - IANA zone that defines "today" (COMPANY_TIMEZONE).
 * @param {() => Date} [dependencies.now] - the clock; injectable so tests do not depend on
 *   wall time.
 */
export function createAttendanceMutationService({
  attendanceRepository,
  employeeRepository,
  timeZone,
  now = () => new Date(),
}) {
  /** D27: work_date must be on or before today in the company timezone, not UTC. */
  function assertNotInFuture(workDate) {
    if (workDate > todayInTimeZone(now(), timeZone)) {
      throw new HttpError(400, "work_date_in_future", "work_date cannot be in the future.");
    }
  }

  /**
   * Required for create and for re-attribution only. An update that leaves employee_id alone
   * does not call this, so a deactivated employee's historical records stay correctable (D27).
   */
  function assertEmployeeActive(employee) {
    if (employee.employment_status !== "active") {
      throw new HttpError(400, "employee_not_active", "Attendance can only be recorded for an active employee.");
    }
  }

  async function loadEmployeeOrReject(employeeId) {
    const employee = await employeeRepository.findById(employeeId);
    if (!employee) {
      throw new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");
    }
    return employee;
  }

  /** The scope input for the employee an existing record currently belongs to. */
  const owningEmployeeOf = (record) => ({ id: record.employee_id, department_id: record.employee_department_id });

  return Object.freeze({
    async createAttendance(principal, input) {
      assertCanWriteAttendance(principal);

      const employee = await loadEmployeeOrReject(input.employee_id);
      assertCanWriteAttendanceFor(principal, employee);
      assertEmployeeActive(employee);
      assertNotInFuture(input.work_date);

      return attendanceRepository.create(input);
    },

    async updateAttendance(principal, attendanceId, changes) {
      assertCanWriteAttendance(principal);

      const existing = await attendanceRepository.findById(attendanceId);
      if (!existing) throw new HttpError(404, "not_found", "Attendance record not found.");

      const from = owningEmployeeOf(existing);
      const isReattributed = Object.hasOwn(changes, "employee_id") && changes.employee_id !== existing.employee_id;

      if (isReattributed) {
        // D27: scope over BOTH the employee it is moving from and the one it is moving to.
        const to = await loadEmployeeOrReject(changes.employee_id);
        assertCanReattributeAttendance(principal, { from, to });
        assertEmployeeActive(to);
      } else {
        assertCanWriteAttendanceFor(principal, from);
      }

      if (Object.hasOwn(changes, "work_date")) assertNotInFuture(changes.work_date);

      const updated = await attendanceRepository.updateById(attendanceId, changes);
      if (!updated) throw new HttpError(404, "not_found", "Attendance record not found.");
      return updated;
    },

    /** Soft delete; the actor is recorded in deleted_by_employee_id. No date or active check. */
    async deleteAttendance(principal, attendanceId) {
      assertCanWriteAttendance(principal);

      const existing = await attendanceRepository.findById(attendanceId);
      if (!existing) throw new HttpError(404, "not_found", "Attendance record not found.");

      assertCanWriteAttendanceFor(principal, owningEmployeeOf(existing));

      await attendanceRepository.deleteById(attendanceId, principal.employeeId);
    },
  });
}
