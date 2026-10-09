import { useCollectionAccess } from "./useFirestore.js";
import { useCollectionResource } from "../hooks/useCollectionResource";
import { departmentService } from "../services/departmentService.js";

// Only admin and hr can read the departments list (D33). Everyone else learns department names from the
// employees and projects they can already see, and the services keep that directory (departmentDirectory.js).
const DEPARTMENT_READERS = new Set(["admin", "hr"]);

export function useDepartments(collectionAccess) {
  const departmentAccess = useCollectionAccess("departments", collectionAccess, DEPARTMENT_READERS, departmentService.list);
  const resource = useCollectionResource("departments", { ...departmentAccess, service: departmentService });

  return {
    departments: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: resource.isMutating,
    addDepartment: resource.create,
    updateDepartment: resource.update,
    deleteDepartment: resource.remove,
  };
}
