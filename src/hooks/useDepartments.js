import { useCollectionAccess } from "./useCollections.js";
import { useCollectionResource } from "./useCollectionResource";
import { departmentService } from "../services/departmentService.js";
import { loadErrorUnlessDenied } from "../utils/loadErrors.js";

// Only admin and hr can read the departments list (D33). Everyone else learns department names from the
// employees and projects they can already see, and the services keep that directory (departmentDirectory.js).
const DEPARTMENT_READERS = new Set(["admin", "hr"]);

export function useDepartments(collectionAccess) {
  const departmentAccess = useCollectionAccess("departments", collectionAccess, DEPARTMENT_READERS, departmentService.list);
  const resource = useCollectionResource("departments", { ...departmentAccess, service: departmentService });
  // Only admin and hr are meant to read this list. If the API ever answers 403 (a deliberate refusal), the list is
  // simply empty for this person: it must not surface as a failed load.
  const loadError = loadErrorUnlessDenied(resource.error);

  return {
    departments: resource.data,
    loading: resource.loading,
    error: loadError || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError,
    isMutating: resource.isMutating,
    addDepartment: resource.create,
    updateDepartment: resource.update,
    deleteDepartment: resource.remove,
  };
}
