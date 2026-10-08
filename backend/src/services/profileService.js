import { HttpError } from "../utils/httpError.js";

/**
 * The signed-in user's own profile (D32): what the frontend needs to build its session, now that
 * Firebase's auth-state listener is gone. The login and refresh responses carry only the principal,
 * `{ userId, employeeId, role, departmentId }`, which is deliberately minimal; this is where the rest
 * comes from.
 *
 * It is always the CALLER'S OWN profile: the employee is taken from `principal.employeeId`, which
 * the authentication middleware resolved from the database, and never from anything in the request.
 * There is therefore nothing to scope and nothing to enumerate.
 *
 * Compensation is deliberately left out. The session does not need `basic` or `allowances`, and a
 * response that is fetched on every page load should carry no more than the session needs. (Field
 * naming for the frontend is D39's mapper's concern; these are the API's names.)
 *
 * @param {object} dependencies
 * @param {{ findById: (id: string) => Promise<object|null> }} dependencies.employeeRepository
 */
export function createProfileService({ employeeRepository }) {
  return Object.freeze({
    async getOwnProfile(principal) {
      const employee = principal?.employeeId ? await employeeRepository.findById(principal.employeeId) : null;
      if (!employee) throw new HttpError(404, "not_found", "Your employee profile was not found.");

      return {
        id: employee.id,
        employee_number: employee.employee_number,
        full_name: employee.full_name,
        email: employee.email,
        phone: employee.phone,
        role: employee.role,
        department_id: employee.department_id,
        department_name: employee.department_name,
        position_title: employee.position_title,
        joined_on: employee.joined_on,
        team_lead_id: employee.team_lead_id,
        employment_status: employee.employment_status,
      };
    },
  });
}
