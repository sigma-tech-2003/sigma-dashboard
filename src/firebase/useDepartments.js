import { useCallback } from "react";
import { useCollectionResource } from "../hooks/useCollectionResource";

const DEPARTMENTS_COLLECTION = "departments";

export function useDepartments() {
  const resource = useCollectionResource(DEPARTMENTS_COLLECTION);
  const { create } = resource;

  const addDepartment = useCallback((department) =>
    create({
      ...department,
      createdAt: new Date().toISOString(),
    }),
  [create]);

  return {
    departments: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addDepartment,
    updateDepartment: resource.update,
    deleteDepartment: resource.remove,
  };
}
