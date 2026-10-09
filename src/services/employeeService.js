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
     * POST /employees/:id/password-token (D34): a single-use link token for the new employee, issued by admin
     * or hr, who then pass the link on. There is no email (D25).
     */
    async issuePasswordSetupLink(id) {
      const { token, expiresAt } = await api.post(`/employees/${id}/password-token`);
      // Only the token: the set-password route that turns it into a link does not exist yet (page work, D34).
      return { token, expiresAt };
    },
  };
}

export const employeeService = createEmployeeService();
