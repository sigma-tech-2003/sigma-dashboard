import { useCollectionResource } from "../hooks/useCollectionResource";

const COLLECTIONS = {
  employees: "employees",
  projects: "projects",
  kpis: "kpis",
  leaves: "leaves",
  payroll: "payroll",
  leaveBalances: "leaveBalances",
};

export function useEmployees() {
  const resource = useCollectionResource(COLLECTIONS.employees);

  return {
    employees: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addEmployee: resource.create,
    updateEmployee: resource.update,
    deleteEmployee: resource.remove,
  };
}

export function useProjects() {
  const resource = useCollectionResource(COLLECTIONS.projects);

  return {
    projects: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addProject: resource.create,
    updateProject: resource.update,
    deleteProject: resource.remove,
  };
}

export function useKpis() {
  const resource = useCollectionResource(COLLECTIONS.kpis);

  return {
    kpis: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addKpi: resource.create,
    updateKpi: resource.update,
  };
}

export function useLeaves() {
  const resource = useCollectionResource(COLLECTIONS.leaves);

  return {
    leaves: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addLeave: resource.create,
    updateLeaveStatus: (id, status) => resource.update(id, { status }),
  };
}

export function usePayroll() {
  const resource = useCollectionResource(COLLECTIONS.payroll);

  return {
    payroll: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    isMutating: resource.isMutating,
    addPayroll: resource.create,
    updatePayrollStatus: (id, status) => resource.update(id, { status }),
  };
}

export function useLeaveBalances() {
  const resource = useCollectionResource(COLLECTIONS.leaveBalances);
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
