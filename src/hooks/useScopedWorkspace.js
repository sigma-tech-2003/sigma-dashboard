import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getScopedWorkspace } from "../services/scopedWorkspaceService";

const EMPTY_RECORDS = Object.freeze([]);
const DISABLED_STATE = Object.freeze({
  requestToken: null,
  projects: EMPTY_RECORDS,
  kpis: EMPTY_RECORDS,
  loading: false,
  error: null,
});
const SCOPED_ROLES = new Set(["manager", "tl"]);

const normalizedString = (value) =>
  (typeof value === "string" ? value.trim() : "");

const principalScope = (linkage, employeeId, employeeRole, employeeDepartment) => {
  const id = normalizedString(employeeId);
  const role = normalizedString(employeeRole).toLowerCase();
  const department = normalizedString(employeeDepartment);
  const hasDepartmentField = typeof employeeDepartment === "string";

  if (
    linkage !== "uid"
    || !id
    || !SCOPED_ROLES.has(role)
    || !hasDepartmentField
    || (role === "manager" && !department)
  ) {
    return null;
  }

  return JSON.stringify({ linkage, id, role, department });
};

const safeWorkspaceData = (value) => {
  if (
    !value
    || typeof value !== "object"
    || !Array.isArray(value.projects)
    || !Array.isArray(value.kpis)
  ) {
    return { projects: EMPTY_RECORDS, kpis: EMPTY_RECORDS };
  }
  return {
    projects: [...value.projects],
    kpis: [...value.kpis],
  };
};

export function useScopedWorkspace(user) {
  const linkage = user?.linkage;
  const employeeId = user?.employee?.id;
  const employeeRole = user?.employee?.role;
  const employeeDepartment = user?.employee?.dept;
  const scopeKey = useMemo(
    () => principalScope(linkage, employeeId, employeeRole, employeeDepartment),
    [employeeDepartment, employeeId, employeeRole, linkage],
  );
  const enabled = scopeKey !== null;
  const [refreshKey, setRefreshKey] = useState(0);
  const requestToken = useMemo(
    () => (enabled ? { scopeKey, refreshKey } : null),
    [enabled, refreshKey, scopeKey],
  );
  const [state, setState] = useState(DISABLED_STATE);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;

    if (!requestToken) {
      return undefined;
    }

    let active = true;
    const isLatestRequest = () =>
      active && requestGeneration.current === generation;

    const load = async () => {
      await Promise.resolve();
      if (!isLatestRequest()) return;
      setState({
        requestToken,
        projects: EMPTY_RECORDS,
        kpis: EMPTY_RECORDS,
        loading: true,
        error: null,
      });

      try {
        const result = await getScopedWorkspace();
        if (!isLatestRequest()) return;
        const workspace = safeWorkspaceData(result);
        setState({
          requestToken,
          projects: workspace.projects,
          kpis: workspace.kpis,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (!isLatestRequest()) return;
        setState({
          requestToken,
          projects: EMPTY_RECORDS,
          kpis: EMPTY_RECORDS,
          loading: false,
          error,
        });
      }
    };

    load();
    return () => {
      active = false;
      if (requestGeneration.current === generation) {
        requestGeneration.current += 1;
      }
    };
  }, [requestToken]);

  const refresh = useCallback(() => {
    if (enabled) setRefreshKey((current) => current + 1);
  }, [enabled]);

  const stateMatchesRequest = enabled && state.requestToken === requestToken;

  return {
    projects: stateMatchesRequest ? state.projects : EMPTY_RECORDS,
    kpis: stateMatchesRequest ? state.kpis : EMPTY_RECORDS,
    loading: enabled && (!stateMatchesRequest || state.loading),
    error: stateMatchesRequest ? state.error : null,
    refresh,
  };
}
