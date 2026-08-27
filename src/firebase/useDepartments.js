import { useCallback, useMemo } from "react";
import {
  useCollectionResource,
  withCollectionSubscription,
} from "../hooks/useCollectionResource";
import { createCollectionSource } from "../services/firestoreService";

const DEPARTMENTS_COLLECTION = "departments";

export function getDepartmentReadPlan(principal) {
  const employee = principal?.employee;
  const employeeId = typeof employee?.id === "string" ? employee.id.trim() : "";
  const role = typeof employee?.role === "string" ? employee.role : "";

  if (
    principal?.linkage === "uid"
    && employeeId
    && (role === "admin" || role === "hr")
  ) {
    return {
      enabled: true,
      queryScope: `departments:${role}:all`,
      sources: [createCollectionSource()],
    };
  }

  return {
    enabled: false,
    queryScope: `departments:${role || "invalid"}:disabled`,
    sources: [],
  };
}

export function useDepartments(collectionAccess) {
  const principal = collectionAccess?.principal;
  const employeeId = principal?.employee?.id;
  const employeeRole = principal?.employee?.role;
  const linkage = principal?.linkage;
  const readPlan = useMemo(
    () => getDepartmentReadPlan({
      linkage,
      employee: { id: employeeId, role: employeeRole },
    }),
    [employeeId, employeeRole, linkage],
  );
  const departmentAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(DEPARTMENTS_COLLECTION, departmentAccess);
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
