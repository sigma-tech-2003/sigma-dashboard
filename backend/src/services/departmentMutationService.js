import { HttpError } from "../utils/httpError.js";
import { assertCanWriteDepartment } from "./departmentAuthorizationService.js";

/**
 * Orchestrates department create/update/delete. Much thinner than
 * employeeMutationService.js: there is no scope to default (admin-only, no department/team
 * scoping) and no cross-table invariant to enforce ahead of a constraint the way D18 needs
 * for employees -- departments_manager_employee_foreign_key fully expresses manager
 * validity on its own, so departmentRepository.js's translateWriteError is sufficient
 * without a parallel pre-check here.
 */
export function createDepartmentMutationService({ departmentRepository }) {
  return Object.freeze({
    async createDepartment(principal, input) {
      assertCanWriteDepartment(principal);
      return departmentRepository.create(input);
    },

    async updateDepartment(principal, departmentId, changes) {
      assertCanWriteDepartment(principal);
      const updated = await departmentRepository.updateById(departmentId, changes);
      if (!updated) throw new HttpError(404, "not_found", "Department not found.");
      return updated;
    },

    async deleteDepartment(principal, departmentId) {
      assertCanWriteDepartment(principal);
      await departmentRepository.deleteById(departmentId);
    },
  });
}
