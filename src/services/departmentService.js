import { departmentDirectory } from "./departmentDirectory.js";
import * as mapper from "./mappers/department.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

// Departments. Only admin and hr can read the list (D33); everyone else learns names from employees and projects.
export function createDepartmentService(api = defaultApi) {
  return createResourceService({
    path: "/departments",
    mapper,
    api,
    onLoaded: (records) => departmentDirectory.learn(records.map((department) => ({ id: department.id, name: department.name }))),
  });
}

export const departmentService = createDepartmentService();
