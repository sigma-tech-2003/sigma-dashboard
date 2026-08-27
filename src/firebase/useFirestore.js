import { useCallback, useMemo, useRef, useState } from "react";
import {
  useCollectionResource,
  withCollectionSubscription,
} from "../hooks/useCollectionResource";
import {
  createCollectionSource,
  createDocumentSource,
  createInternalQuerySource,
  createWhereSource,
} from "../services/firestoreService";
import {
  createProject as createProjectWithCallable,
  deleteProject as deleteProjectWithCallable,
  updateProject as updateProjectWithCallable,
} from "../services/projectMutationService";
import {
  createKpi as createKpiWithCallable,
  deleteKpi as deleteKpiWithCallable,
  KpiMutationError,
  updateKpi as updateKpiWithCallable,
} from "../services/kpiMutationService";
import {
  deleteEmployee as deleteEmployeeWithCallable,
  EmployeeMutationError,
  updateEmployee as updateEmployeeWithCallable,
} from "../services/employeeMutationService";

const COLLECTIONS = {
  employees: "employees",
  projects: "projects",
  kpis: "kpis",
  attendance: "attendance",
  leaves: "leaves",
  payroll: "payroll",
  leaveBalances: "leaveBalances",
};

const disabledEmployeePlan = () => ({
  enabled: false,
  queryScope: "employees:disabled",
  sources: [],
});

const MANAGEMENT_ROLES = new Set(["admin", "hr"]);
const SCOPED_WORKFORCE_ROLES = new Set(["manager", "tl"]);
const MAX_IN_QUERY_VALUES = 30;

const disabledReadPlan = (queryScope) => ({
  enabled: false,
  queryScope,
  sources: [],
});

const getCanonicalDocumentId = (value) => {
  const id = typeof value === "string" ? value.trim() : "";
  return id && !id.includes("/") ? id : "";
};

const getVerifiedPrincipal = (principal) => {
  const employee = principal?.employee;
  const id = getCanonicalDocumentId(employee?.id);
  const role = typeof employee?.role === "string" ? employee.role : "";
  if (principal?.linkage !== "uid" || !id) return null;
  return { id, role };
};

export function getRelationshipIdVariants(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return [];

  const variants = [id];
  if (/^(0|[1-9]\d*)$/.test(id)) {
    const numericId = Number(id);
    if (Number.isSafeInteger(numericId) && String(numericId) === id) {
      variants.push(numericId);
    }
  }
  return variants;
}

const deduplicateQueryValues = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function chunkQueryValues(values, size = MAX_IN_QUERY_VALUES) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_IN_QUERY_VALUES) {
    throw new TypeError("A valid Firestore in-query chunk size is required.");
  }
  if (!Array.isArray(values) || values.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

const getScopedEmployeeRelationshipIds = (employees) => {
  if (!Array.isArray(employees)) return [];
  return deduplicateQueryValues(employees.flatMap((employee) => {
    const id = getCanonicalDocumentId(employee?._docId);
    return id ? [id] : [];
  })).sort((left, right) => left.localeCompare(right));
};

const createEmployeeRelationshipSources = (ids, extraConstraints = []) =>
  chunkQueryValues(ids).map((values) => createInternalQuerySource([
    { field: "empId", operator: "in", value: values },
    ...extraConstraints,
  ]));

const getRelationshipReadPlan = (
  collectionName,
  principal,
  scopedEmployees,
  scopedEmployeesLoading,
) => {
  const verified = getVerifiedPrincipal(principal);
  if (!verified) return disabledReadPlan(`${collectionName}:invalid-principal`);

  if (MANAGEMENT_ROLES.has(verified.role)) {
    return {
      enabled: true,
      queryScope: `${collectionName}:${verified.role}:all`,
      sources: [createCollectionSource()],
    };
  }

  if (SCOPED_WORKFORCE_ROLES.has(verified.role)) {
    if (scopedEmployeesLoading) {
      return disabledReadPlan(`${collectionName}:${verified.role}:awaiting-employees`);
    }
    const ids = getScopedEmployeeRelationshipIds(scopedEmployees);
    const sources = createEmployeeRelationshipSources(ids);
    if (sources.length === 0) {
      return disabledReadPlan(`${collectionName}:${verified.role}:empty`);
    }
    return {
      enabled: true,
      queryScope: `${collectionName}:${verified.role}:${JSON.stringify(ids)}`,
      sources,
    };
  }

  if (verified.role === "employee") {
    const ids = [verified.id];
    return {
      enabled: true,
      queryScope: `${collectionName}:employee:${JSON.stringify(ids)}`,
      sources: createEmployeeRelationshipSources(ids),
    };
  }

  return disabledReadPlan(`${collectionName}:unsupported-role`);
};

export const getAttendanceReadPlan = (principal, employees, employeesLoading) =>
  getRelationshipReadPlan(
    COLLECTIONS.attendance,
    principal,
    employees,
    employeesLoading,
  );

export const getLeaveReadPlan = (principal, employees, employeesLoading) =>
  getRelationshipReadPlan(COLLECTIONS.leaves, principal, employees, employeesLoading);

export function getPayrollReadPlan(principal) {
  const verified = getVerifiedPrincipal(principal);
  if (!verified) return disabledReadPlan("payroll:invalid-principal");

  if (MANAGEMENT_ROLES.has(verified.role)) {
    return {
      enabled: true,
      queryScope: `payroll:${verified.role}:all`,
      sources: [createCollectionSource()],
    };
  }
  if (SCOPED_WORKFORCE_ROLES.has(verified.role)) {
    return disabledReadPlan(`payroll:${verified.role}:disabled`);
  }
  if (verified.role === "employee") {
    const ids = [verified.id];
    return {
      enabled: true,
      queryScope: `payroll:employee:${JSON.stringify(ids)}:processed`,
      sources: createEmployeeRelationshipSources(ids, [
        { field: "status", operator: "==", value: "processed" },
      ]),
    };
  }
  return disabledReadPlan("payroll:unsupported-role");
}

export function getLeaveBalanceReadPlan(principal) {
  const verified = getVerifiedPrincipal(principal);
  if (!verified || verified.role !== "employee") {
    return disabledReadPlan("leaveBalances:disabled");
  }
  return {
    enabled: true,
    queryScope: `leaveBalances:employee:${verified.id}`,
    sources: [createDocumentSource(verified.id)],
  };
}

const employeeProjectSources = (employeeId) =>
  [createInternalQuerySource([
    { field: "assignedEmployeeIds", operator: "array-contains", value: employeeId },
  ])];

const employeeKpiSources = (employeeId) =>
  [createInternalQuerySource([
    { field: "empId", operator: "in", value: [employeeId] },
  ])];

export function getProjectReadPlan(principal) {
  const verified = getVerifiedPrincipal(principal);
  if (!verified) return disabledReadPlan("projects:invalid-principal");
  if (MANAGEMENT_ROLES.has(verified.role)) {
    return {
      enabled: true,
      queryScope: `projects:${verified.role}:all`,
      sources: [createCollectionSource()],
    };
  }
  if (SCOPED_WORKFORCE_ROLES.has(verified.role)) {
    return disabledReadPlan(`projects:${verified.role}:callable`);
  }
  if (verified.role === "employee") {
    const sources = employeeProjectSources(verified.id);
    return {
      enabled: sources.length > 0,
      queryScope: `projects:employee:${verified.id}`,
      sources,
    };
  }
  return disabledReadPlan("projects:unsupported-role");
}

export function getKpiReadPlan(principal) {
  const verified = getVerifiedPrincipal(principal);
  if (!verified) return disabledReadPlan("kpis:invalid-principal");
  if (MANAGEMENT_ROLES.has(verified.role)) {
    return {
      enabled: true,
      queryScope: `kpis:${verified.role}:all`,
      sources: [createCollectionSource()],
    };
  }
  if (SCOPED_WORKFORCE_ROLES.has(verified.role)) {
    return disabledReadPlan(`kpis:${verified.role}:callable`);
  }
  if (verified.role === "employee") {
    const sources = employeeKpiSources(verified.id);
    return {
      enabled: sources.length > 0,
      queryScope: `kpis:employee:${verified.id}`,
      sources,
    };
  }
  return disabledReadPlan("kpis:unsupported-role");
}

const useScopedMutationRefresh = (principal, workspace) => {
  const role = principal?.employee?.role;
  const workspaceRefresh = workspace?.refresh;
  return useCallback(() => {
    if (!SCOPED_WORKFORCE_ROLES.has(role) || typeof workspaceRefresh !== "function") return;
    try {
      const refreshResult = workspaceRefresh();
      if (refreshResult && typeof refreshResult.catch === "function") {
        refreshResult.catch(() => {});
      }
    } catch {
      // A completed Firestore mutation remains successful if reloading fails.
    }
  }, [role, workspaceRefresh]);
};

const useProjectMutationOperations = (cacheIdentity, refresh) => {
  const [mutationState, setMutationState] = useState({
    cacheIdentity: null,
    error: null,
    pendingCount: 0,
  });
  const inFlightMutations = useRef(new Map());

  const runMutation = useCallback((operationKey, operation, resultValue) => {
    const mutationIdentity = cacheIdentity || "projects:disabled";
    const requestKey = `${mutationIdentity}:${operationKey}`;
    const existingRequest = inFlightMutations.current.get(requestKey);
    if (existingRequest) return existingRequest;

    setMutationState((current) => ({
      cacheIdentity: mutationIdentity,
      error: null,
      pendingCount: current.cacheIdentity === mutationIdentity
        ? current.pendingCount + 1
        : 1,
    }));

    const request = Promise.resolve()
      .then(operation)
      .then(resultValue)
      .then((result) => {
        refresh();
        return result;
      })
      .catch((error) => {
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, error }
          : current);
        throw error;
      })
      .finally(() => {
        inFlightMutations.current.delete(requestKey);
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, pendingCount: Math.max(0, current.pendingCount - 1) }
          : current);
      });
    inFlightMutations.current.set(requestKey, request);
    return request;
  }, [cacheIdentity, refresh]);

  const addProject = useCallback((project) => runMutation(
    "create",
    () => createProjectWithCallable(project),
    (createdProject) => createdProject.id,
  ), [runMutation]);
  const updateProject = useCallback((projectId, updates) => runMutation(
    `update:${String(projectId)}`,
    () => updateProjectWithCallable(projectId, updates),
    () => undefined,
  ), [runMutation]);
  const deleteProject = useCallback((projectId) => runMutation(
    `delete:${String(projectId)}`,
    () => deleteProjectWithCallable(projectId),
    () => undefined,
  ), [runMutation]);
  const stateMatchesIdentity = mutationState.cacheIdentity
    === (cacheIdentity || "projects:disabled");

  return {
    addProject,
    updateProject,
    deleteProject,
    mutationError: stateMatchesIdentity ? mutationState.error : null,
    isMutating: stateMatchesIdentity && mutationState.pendingCount > 0,
  };
};

const useKpiMutationOperations = (cacheIdentity, principal, refresh) => {
  const [mutationState, setMutationState] = useState({
    cacheIdentity: null,
    error: null,
    pendingCount: 0,
  });
  const inFlightMutations = useRef(new Map());
  const role = principal?.employee?.role;
  const canMutate = MANAGEMENT_ROLES.has(role) || SCOPED_WORKFORCE_ROLES.has(role);

  const runMutation = useCallback((operationKey, operation, resultValue) => {
    if (!canMutate) return Promise.reject(new KpiMutationError("permission-denied"));

    const mutationIdentity = cacheIdentity || "kpis:disabled";
    const requestKey = `${mutationIdentity}:${operationKey}`;
    const existingRequest = inFlightMutations.current.get(requestKey);
    if (existingRequest) return existingRequest;

    setMutationState((current) => ({
      cacheIdentity: mutationIdentity,
      error: null,
      pendingCount: current.cacheIdentity === mutationIdentity
        ? current.pendingCount + 1
        : 1,
    }));

    const request = Promise.resolve()
      .then(operation)
      .then(resultValue)
      .then((result) => {
        refresh();
        return result;
      })
      .catch((error) => {
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, error }
          : current);
        throw error;
      })
      .finally(() => {
        inFlightMutations.current.delete(requestKey);
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, pendingCount: Math.max(0, current.pendingCount - 1) }
          : current);
      });
    inFlightMutations.current.set(requestKey, request);
    return request;
  }, [cacheIdentity, canMutate, refresh]);

  const addKpi = useCallback((kpi) => runMutation(
    "create",
    () => createKpiWithCallable(kpi),
    (createdKpi) => createdKpi.id,
  ), [runMutation]);
  const updateKpi = useCallback((kpiId, updates) => runMutation(
    `record:${String(kpiId)}`,
    () => updateKpiWithCallable(kpiId, updates),
    () => undefined,
  ), [runMutation]);
  const deleteKpi = useCallback((kpiId) => runMutation(
    `record:${String(kpiId)}`,
    () => deleteKpiWithCallable(kpiId),
    () => undefined,
  ), [runMutation]);
  const stateMatchesIdentity = mutationState.cacheIdentity
    === (cacheIdentity || "kpis:disabled");

  return {
    addKpi,
    updateKpi,
    deleteKpi,
    mutationError: stateMatchesIdentity ? mutationState.error : null,
    isMutating: stateMatchesIdentity && mutationState.pendingCount > 0,
  };
};

const useEmployeeMutationOperations = (cacheIdentity, principal) => {
  const [mutationState, setMutationState] = useState({
    cacheIdentity: null,
    error: null,
    pendingCount: 0,
  });
  const inFlightMutations = useRef(new Map());
  const role = principal?.employee?.role;
  const canMutate = MANAGEMENT_ROLES.has(role) || SCOPED_WORKFORCE_ROLES.has(role);

  const runMutation = useCallback((operationName, employeeId, operation, resultValue) => {
    if (!canMutate) return Promise.reject(new EmployeeMutationError("permission-denied"));

    const mutationIdentity = cacheIdentity || "employees:disabled";
    const requestKey = `${mutationIdentity}:employee:${String(employeeId)}`;
    const existingRequest = inFlightMutations.current.get(requestKey);
    if (existingRequest) {
      return existingRequest.operationName === operationName
        ? existingRequest.promise
        : Promise.reject(new EmployeeMutationError("failed-precondition"));
    }

    setMutationState((current) => ({
      cacheIdentity: mutationIdentity,
      error: null,
      pendingCount: current.cacheIdentity === mutationIdentity
        ? current.pendingCount + 1
        : 1,
    }));

    const request = Promise.resolve()
      .then(operation)
      .then(resultValue)
      .catch((error) => {
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, error }
          : current);
        throw error;
      })
      .finally(() => {
        inFlightMutations.current.delete(requestKey);
        setMutationState((current) => current.cacheIdentity === mutationIdentity
          ? { ...current, pendingCount: Math.max(0, current.pendingCount - 1) }
          : current);
      });
    inFlightMutations.current.set(requestKey, { operationName, promise: request });
    return request;
  }, [cacheIdentity, canMutate]);

  const addEmployee = useCallback(() =>
    Promise.reject(new EmployeeMutationError("invitation-required")), []);
  const updateEmployee = useCallback((employeeId, updates) => runMutation(
    "update",
    employeeId,
    () => updateEmployeeWithCallable(employeeId, updates),
    () => undefined,
  ), [runMutation]);
  const deleteEmployee = useCallback((employeeId) => runMutation(
    "delete",
    employeeId,
    () => deleteEmployeeWithCallable(employeeId),
    () => undefined,
  ), [runMutation]);
  const stateMatchesIdentity = mutationState.cacheIdentity
    === (cacheIdentity || "employees:disabled");

  return {
    addEmployee,
    updateEmployee,
    deleteEmployee,
    mutationError: stateMatchesIdentity ? mutationState.error : null,
    isMutating: stateMatchesIdentity && mutationState.pendingCount > 0,
  };
};

export function getEmployeeReadPlan(principal) {
  const employee = principal?.employee;
  const employeeId = getCanonicalDocumentId(employee?.id);
  const role = typeof employee?.role === "string" ? employee.role : "";
  const department = typeof employee?.dept === "string" ? employee.dept.trim() : "";

  if (principal?.linkage !== "uid" || !employeeId) return disabledEmployeePlan();
  if (role === "admin" || role === "hr") {
    return {
      enabled: true,
      queryScope: `employees:${role}:all`,
      sources: [createCollectionSource()],
    };
  }
  if (role === "manager" && department) {
    return {
      enabled: true,
      queryScope: "employees:manager:department",
      sources: [createWhereSource("dept", department)],
    };
  }
  if (role === "tl") {
    return {
      enabled: true,
      queryScope: "employees:tl:self-and-team",
      sources: [
        createDocumentSource(employeeId),
        createWhereSource("teamLeadId", employeeId),
      ],
    };
  }
  if (role === "employee") {
    return {
      enabled: true,
      queryScope: "employees:employee:self",
      sources: [createDocumentSource(employeeId)],
    };
  }
  return disabledEmployeePlan();
}

export function useEmployees(collectionAccess) {
  const principal = collectionAccess?.principal;
  const employeeId = principal?.employee?.id;
  const employeeRole = principal?.employee?.role;
  const employeeDepartment = principal?.employee?.dept;
  const linkage = principal?.linkage;
  const readPlan = useMemo(
    () => getEmployeeReadPlan({
      linkage,
      employee: {
        id: employeeId,
        role: employeeRole,
        dept: employeeDepartment,
      },
    }),
    [employeeDepartment, employeeId, employeeRole, linkage],
  );
  const employeeAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.employees, employeeAccess);
  const employeeMutations = useEmployeeMutationOperations(
    resource.cacheIdentity,
    principal,
  );

  return {
    employees: resource.data,
    loading: resource.loading,
    error: resource.error || employeeMutations.mutationError,
    isMutating: employeeMutations.isMutating,
    addEmployee: employeeMutations.addEmployee,
    updateEmployee: employeeMutations.updateEmployee,
    deleteEmployee: employeeMutations.deleteEmployee,
  };
}

export function useProjects(collectionAccess, workspace) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(() => getProjectReadPlan(principal), [principal]);
  const projectAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.projects, projectAccess);
  const refresh = useScopedMutationRefresh(principal, workspace);
  const projectMutations = useProjectMutationOperations(resource.cacheIdentity, refresh);
  const callableBacked = SCOPED_WORKFORCE_ROLES.has(principal?.employee?.role);

  return {
    projects: callableBacked && Array.isArray(workspace?.projects)
      ? workspace.projects
      : callableBacked ? [] : resource.data,
    loading: callableBacked ? Boolean(workspace?.loading) : resource.loading,
    error: callableBacked
      ? workspace?.error || projectMutations.mutationError
      : resource.error || projectMutations.mutationError,
    isMutating: projectMutations.isMutating,
    addProject: projectMutations.addProject,
    updateProject: projectMutations.updateProject,
    deleteProject: projectMutations.deleteProject,
  };
}

export function useKpis(collectionAccess, workspace) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(() => getKpiReadPlan(principal), [principal]);
  const kpiAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.kpis, kpiAccess);
  const refresh = useScopedMutationRefresh(principal, workspace);
  const kpiMutations = useKpiMutationOperations(resource.cacheIdentity, principal, refresh);
  const callableBacked = SCOPED_WORKFORCE_ROLES.has(principal?.employee?.role);

  return {
    kpis: callableBacked && Array.isArray(workspace?.kpis)
      ? workspace.kpis
      : callableBacked ? [] : resource.data,
    loading: callableBacked ? Boolean(workspace?.loading) : resource.loading,
    error: callableBacked
      ? workspace?.error || kpiMutations.mutationError
      : resource.error || kpiMutations.mutationError,
    isMutating: kpiMutations.isMutating,
    addKpi: kpiMutations.addKpi,
    updateKpi: kpiMutations.updateKpi,
    deleteKpi: kpiMutations.deleteKpi,
  };
}

export function useAttendance(collectionAccess, employees = [], employeesLoading = false) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(
    () => getAttendanceReadPlan(principal, employees, employeesLoading),
    [employees, employeesLoading, principal],
  );
  const attendanceAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.attendance, attendanceAccess);

  return {
    attendance: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addAttendance: resource.create,
    updateAttendance: resource.update,
    deleteAttendance: resource.remove,
  };
}

export function useLeaves(collectionAccess, employees = [], employeesLoading = false) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(
    () => getLeaveReadPlan(principal, employees, employeesLoading),
    [employees, employeesLoading, principal],
  );
  const leaveAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.leaves, leaveAccess);

  return {
    leaves: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addLeave: resource.create,
    updateLeaveStatus: (id, status) => resource.update(id, { status }),
  };
}

export function usePayroll(collectionAccess) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(() => getPayrollReadPlan(principal), [principal]);
  const payrollAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.payroll, payrollAccess);

  return {
    payroll: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addPayroll: resource.create,
    updatePayrollStatus: (id, status) => resource.update(id, { status }),
  };
}

export function useLeaveBalances(collectionAccess) {
  const principal = collectionAccess?.principal;
  const readPlan = useMemo(() => getLeaveBalanceReadPlan(principal), [principal]);
  const leaveBalanceAccess = useMemo(
    () => withCollectionSubscription(collectionAccess, readPlan),
    [collectionAccess, readPlan],
  );
  const resource = useCollectionResource(COLLECTIONS.leaveBalances, leaveBalanceAccess);
  const leaveBalances = resource.data.reduce((balances, { _docId, ...balance }) => {
    balances[_docId] = balance;
    return balances;
  }, {});

  return {
    leaveBalances,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
  };
}
