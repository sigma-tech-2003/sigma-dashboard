import { departmentDirectory } from "./departmentDirectory.js";
import * as mapper from "./mappers/project.js";
import { createResourceService } from "./resourceService.js";
import { api as defaultApi } from "./apiClient.js";

export function createProjectService(api = defaultApi) {
  return createResourceService({
    path: "/projects",
    mapper,
    api,
    onLoaded: (records) => departmentDirectory.learnFromRecords(records, "department"),
    writeContext: () => ({ departments: departmentDirectory.lookup() }),
  });
}

export const projectService = createProjectService();
