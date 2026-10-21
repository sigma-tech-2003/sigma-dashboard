import { departmentDirectory } from "./departmentDirectory.js";
import * as mapper from "./mappers/employee.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

// Employees. Creating or editing one needs a department id, resolved from the department NAME the page holds
// through the directory the data hooks fill (see departmentDirectory.js).
export function createEmployeeService(api = defaultApi) {
  const base = createResourceService({
    path: "/employees",
    mapper,
    api,
    onLoaded: (records) => departmentDirectory.learnFromRecords(records, "dept"),
    writeContext: () => ({ departments: departmentDirectory.lookup() }),
  });

  return {
    ...base,

    /**
     * DELETE /employees/:id. A team lead who still has team members cannot be removed without a replacement
     * chosen from those members, so `replacementTeamLeadId` goes in the body; without one the API refuses with
     * `team_lead_replacement_required`.
     */
    remove: (id, { replacementTeamLeadId } = {}) => base.remove(id, mapper.toApiDelete({ replacementTeamLeadId })),

    /**
     * POST /employees/:id/temporary-password (D41): admin or hr give an existing employee a new temporary password.
     * The employee must replace it at next sign-in and their current sessions end. Resolves with nothing (204).
     */
    async setTemporaryPassword(id, temporaryPassword) {
      await api.post(`/employees/${id}/temporary-password`, { temporary_password: temporaryPassword });
    },
  };
}

export const employeeService = createEmployeeService();
