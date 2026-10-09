import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth.js";
import {
  useCollectionResource,
  withCollectionSubscription,
} from "../hooks/useCollectionResource";
import { attendanceService } from "../services/attendanceService.js";
import { employeeService } from "../services/employeeService.js";
import {
  deleteEmployee as deleteEmployeeRequest,
  EmployeeMutationError,
  updateEmployee as updateEmployeeRequest,
} from "../services/employeeMutationService.js";
import { findRecordById } from "../services/legacyShape.js";
import { kpiService } from "../services/kpiService.js";
import {
  createKpi as createKpiRequest,
  deleteKpi as deleteKpiRequest,
  KpiMutationError,
  updateKpi as updateKpiRequest,
} from "../services/kpiMutationService.js";
import { leaveBalanceService } from "../services/leaveBalanceService.js";
import { leaveService } from "../services/leaveService.js";
import { payrollService } from "../services/payrollService.js";
import {
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  ProjectMutationError,
  updateProject as updateProjectRequest,
} from "../services/projectMutationService.js";
import { projectService } from "../services/projectService.js";

// The app's data layer. The file keeps its Firebase-era name and location so App.jsx's import is unchanged; every
// hook returns exactly the shape it did under Firestore, but reads through the API (polled, services/polling.js)
// and writes through the domain services. Migration-plan Phase 10 item 1 moves it to src/hooks/ with the
// App.jsx import change, once the Firebase code goes (Phase 11).
//
// There are no per-role read plans any more: the API scopes every read server-side, so a hook only declines to
// ask for what the API would answer with nothing (payroll for a manager, the departments list for a non-admin).

const EVERY_ROLE = new Set(["admin", "hr", "manager", "tl", "employee"]);
const MANAGEMENT_ROLES = new Set(["admin", "hr"]);
const SCOPED_WORKFORCE_ROLES = new Set(["manager", "tl"]);
const MAY_MUTATE = new Set([...MANAGEMENT_ROLES, ...SCOPED_WORKFORCE_ROLES]);
const PAYROLL_ROLES = new Set(["admin", "hr", "employee"]);

const useLatest = (value) => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
};

/** The collection access for one resource: enabled for the roles that can read it, fetching with `fetch`. */
export function useCollectionAccess(collectionName, collectionAccess, allowedRoles, fetch) {
  const role = collectionAccess?.principal?.employee?.role;
  const allowed = allowedRoles.has(role);
  return useMemo(
    () => withCollectionSubscription(collectionAccess, {
      enabled: allowed,
      queryScope: `${collectionName}:${role || "invalid"}`,
      fetch,
    }),
    [allowed, collectionAccess, collectionName, fetch, role],
  );
}

/**
 * Runs a write at most once per key at a time, tracks pending/error, and polls the list again when it succeeds.
 * The same operation on the same key shares one request; a different operation on a key already busy is refused.
 */
export function useMutationRunner({ identity, canMutate, makeError, refresh }) {
  const [state, setState] = useState({ identity: null, error: null, pendingCount: 0 });
  const inFlight = useRef(new Map());
  const mutationIdentity = identity || "disabled";

  const run = useCallback((key, operationName, operation, resultValue = () => undefined) => {
    if (!canMutate) return Promise.reject(makeError("permission-denied"));

    const requestKey = `${mutationIdentity}:${key}`;
    const existing = inFlight.current.get(requestKey);
    if (existing) {
      return existing.operationName === operationName
        ? existing.promise
        : Promise.reject(makeError("failed-precondition"));
    }

    setState((current) => ({
      identity: mutationIdentity,
      error: null,
      pendingCount: current.identity === mutationIdentity ? current.pendingCount + 1 : 1,
    }));

    const promise = Promise.resolve()
      .then(operation)
      .then(async (result) => {
        await Promise.resolve(refresh()).catch(() => {});
        return resultValue(result);
      })
      .catch((error) => {
        setState((current) => current.identity === mutationIdentity ? { ...current, error } : current);
        throw error;
      })
      .finally(() => {
        inFlight.current.delete(requestKey);
        setState((current) => current.identity === mutationIdentity
          ? { ...current, pendingCount: Math.max(0, current.pendingCount - 1) }
          : current);
      });
    inFlight.current.set(requestKey, { operationName, promise });
    return promise;
  }, [canMutate, makeError, mutationIdentity, refresh]);

  const matches = state.identity === mutationIdentity;
  return {
    run,
    mutationError: matches ? state.error : null,
    isMutating: matches && state.pendingCount > 0,
  };
}

export function useEmployees(collectionAccess) {
  const principal = collectionAccess?.principal;
  const ownId = principal?.employee?.id;
  const { refreshProfile } = useAuth();
  const employeeAccess = useCollectionAccess("employees", collectionAccess, EVERY_ROLE, employeeService.list);
  const resource = useCollectionResource("employees", { ...employeeAccess, service: employeeService });
  const dataRef = useLatest(resource.rawData);
  const makeError = useCallback((code) => new EmployeeMutationError(code), []);
  const runner = useMutationRunner({
    identity: resource.cacheIdentity,
    canMutate: MAY_MUTATE.has(principal?.employee?.role),
    makeError,
    refresh: resource.refresh,
  });

  const addEmployee = useCallback(() =>
    Promise.reject(new EmployeeMutationError("invitation-required")), []);
  const updateEmployee = useCallback((employeeId, updates) => runner.run(
    `employee:${String(employeeId)}`,
    "update",
    async () => {
      const result = await updateEmployeeRequest(employeeId, updates, {
        original: findRecordById(dataRef.current, employeeId) ?? undefined,
      });
      // Editing your own record changes what the header shows; re-read the session user.
      if (String(employeeId) === String(ownId)) await refreshProfile().catch(() => {});
      return result;
    },
  ), [dataRef, ownId, refreshProfile, runner]);
  const deleteEmployee = useCallback((employeeId, options) => runner.run(
    `employee:${String(employeeId)}`,
    "delete",
    () => deleteEmployeeRequest(employeeId, options),
  ), [runner]);

  return {
    employees: resource.data,
    loading: resource.loading,
    error: resource.error || runner.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: runner.isMutating,
    addEmployee,
    updateEmployee,
    deleteEmployee,
  };
}

// `workspace` is the old callable-backed manager/tl read (useScopedWorkspace). Managers and tls now read
// projects and KPIs directly like everyone else, so it is accepted and ignored.
export function useProjects(collectionAccess) {
  const principal = collectionAccess?.principal;
  const projectAccess = useCollectionAccess("projects", collectionAccess, EVERY_ROLE, projectService.list);
  const resource = useCollectionResource("projects", { ...projectAccess, service: projectService });
  const dataRef = useLatest(resource.rawData);
  const makeError = useCallback((code) => new ProjectMutationError(code), []);
  const runner = useMutationRunner({
    identity: resource.cacheIdentity,
    canMutate: Boolean(principal),
    makeError,
    refresh: resource.refresh,
  });

  const addProject = useCallback((project) => runner.run(
    "create", "create",
    () => createProjectRequest(project),
    (created) => created.id,
  ), [runner]);
  const updateProject = useCallback((projectId, updates) => runner.run(
    `update:${String(projectId)}`, "update",
    () => updateProjectRequest(projectId, updates, { original: findRecordById(dataRef.current, projectId) ?? undefined }),
  ), [dataRef, runner]);
  const deleteProject = useCallback((projectId) => runner.run(
    `delete:${String(projectId)}`, "delete",
    () => deleteProjectRequest(projectId),
  ), [runner]);

  return {
    projects: resource.data,
    loading: resource.loading,
    error: resource.error || runner.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: runner.isMutating,
    addProject,
    updateProject,
    deleteProject,
  };
}

export function useKpis(collectionAccess) {
  const principal = collectionAccess?.principal;
  const kpiAccess = useCollectionAccess("kpis", collectionAccess, EVERY_ROLE, kpiService.list);
  const resource = useCollectionResource("kpis", { ...kpiAccess, service: kpiService });
  const dataRef = useLatest(resource.rawData);
  const makeError = useCallback((code) => new KpiMutationError(code), []);
  const runner = useMutationRunner({
    identity: resource.cacheIdentity,
    canMutate: MAY_MUTATE.has(principal?.employee?.role),
    makeError,
    refresh: resource.refresh,
  });

  const addKpi = useCallback((kpi) => runner.run(
    "create", "create",
    () => createKpiRequest(kpi),
    (created) => created.id,
  ), [runner]);
  const updateKpi = useCallback((kpiId, updates) => runner.run(
    `record:${String(kpiId)}`, "update",
    () => updateKpiRequest(kpiId, updates, { original: findRecordById(dataRef.current, kpiId) ?? undefined }),
  ), [dataRef, runner]);
  const deleteKpi = useCallback((kpiId) => runner.run(
    `record:${String(kpiId)}`, "delete",
    () => deleteKpiRequest(kpiId),
  ), [runner]);

  return {
    kpis: resource.data,
    loading: resource.loading,
    error: resource.error || runner.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: runner.isMutating,
    addKpi,
    updateKpi,
    deleteKpi,
  };
}

// `employees` and `employeesLoading` used to build Firestore's per-team `in` queries; the API scopes the read.
export function useAttendance(collectionAccess) {
  const attendanceAccess = useCollectionAccess("attendance", collectionAccess, EVERY_ROLE, attendanceService.list);
  const resource = useCollectionResource("attendance", { ...attendanceAccess, service: attendanceService });

  return {
    attendance: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: resource.isMutating,
    addAttendance: resource.create,
    updateAttendance: resource.update,
    deleteAttendance: resource.remove,
  };
}

export function useLeaves(collectionAccess) {
  const leaveAccess = useCollectionAccess("leaves", collectionAccess, EVERY_ROLE, leaveService.list);
  const resource = useCollectionResource("leaves", { ...leaveAccess, service: leaveService });
  const { run } = resource;
  const updateLeaveStatus = useCallback((id, status) => run(() => leaveService.decide(id, status)), [run]);
  // An employee cancelling their own pending request (admin and hr delete with the same call). New: no page
  // calls it yet.
  const cancelLeave = useCallback((id) => run(() => leaveService.cancel(id)), [run]);

  return {
    leaves: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: resource.isMutating,
    addLeave: resource.create,
    updateLeaveStatus,
    cancelLeave,
  };
}

export function usePayroll(collectionAccess) {
  const payrollAccess = useCollectionAccess("payroll", collectionAccess, PAYROLL_ROLES, payrollService.list);
  const resource = useCollectionResource("payroll", { ...payrollAccess, service: payrollService });
  const { update } = resource;
  const updatePayrollStatus = useCallback((id, status) => update(id, { status }), [update]);

  return {
    payroll: resource.data,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
    isMutating: resource.isMutating,
    addPayroll: resource.create,
    updatePayrollStatus,
  };
}

// Leave USAGE now (D40), keyed by employee id: { [employeeId]: { taken, total, year, asOf } }. The pages' cards
// still read `.t` / `.r`, which no longer exist; that is the Phase 10 UI change, not something to fake here.
const ONLY_EMPLOYEES = new Set(["employee"]);

export function useLeaveBalances(collectionAccess) {
  const ownId = collectionAccess?.principal?.employee?.id;
  const fetchOwn = useCallback(() => leaveBalanceService.forEmployee(ownId), [ownId]);
  const leaveBalanceAccess = useCollectionAccess("leaveBalances", collectionAccess, ONLY_EMPLOYEES, fetchOwn);
  const resource = useCollectionResource("leaveBalances", { ...leaveBalanceAccess, service: null });
  const leaveBalances = useMemo(
    () => resource.data.reduce((balances, { _docId, ...balance }) => {
      balances[_docId] = balance;
      return balances;
    }, {}),
    [resource.data],
  );

  return {
    leaveBalances,
    loading: resource.loading,
    error: resource.error || resource.mutationError,
    // The LOAD error alone: `error` above also carries a failed write, which must not read as a failed load.
    loadError: resource.error,
  };
}
