import { lazy, Suspense, useEffect, useMemo } from "react";
import { AppProvider, useApp } from "./app/index.js";
import Layout from "./components/layout/Layout";
import LoadingScreen from "./components/loading-screen/LoadingScreen";
import {
  APP_ROUTES,
  canAccessRoute,
  getDefaultRoute,
  getRouteById,
} from "./config/routes";
import { useDepartments } from "./firebase/useDepartments";
import {
  useAttendance,
  useEmployees,
  useKpis,
  useLeaveBalances,
  useLeaves,
  usePayroll,
  useProjects,
} from "./firebase/useFirestore";
import { useHashNavigation } from "./hooks/useHashNavigation";
import { useScopedWorkspace } from "./hooks/useScopedWorkspace";
import LoginPage from "./pages/login-page/LoginPage";

const PAGE_COMPONENTS = Object.fromEntries(
  APP_ROUTES.map((route) => [route.id, lazy(route.load)]),
);
const FULL_COLLECTION_SCOPE = "full-collection";

const verifiedPrincipalFromUser = (user) => {
  const employeeId = typeof user?.id === "string" ? user.id.trim() : "";
  const role = typeof user?.role === "string" ? user.role.trim() : "";

  if (!employeeId || !role || typeof user?.dept !== "string") return null;
  return { linkage: "uid", employee: user };
};

function AuthenticatedWorkspace({
  principal,
  routeId,
  navigate,
  reportError,
  clearError,
  setLoading,
  logout,
}) {
  const user = principal.employee;
  const collectionAccess = useMemo(() => ({
    enabled: principal.linkage === "uid" && Boolean(user.id),
    principal,
    subscription: { queryScope: FULL_COLLECTION_SCOPE },
  }), [principal, user.id]);
  const scopedWorkspace = useScopedWorkspace(principal);
  const {
    employees,
    loading: employeesLoading,
    error: employeesError,
    addEmployee,
    updateEmployee,
    deleteEmployee,
  } = useEmployees(collectionAccess);
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    addProject,
    updateProject,
    deleteProject,
  } = useProjects(collectionAccess, scopedWorkspace);
  const {
    kpis,
    loading: kpisLoading,
    error: kpisError,
    addKpi,
    updateKpi,
  } = useKpis(collectionAccess, scopedWorkspace);
  const {
    attendance,
    loading: attendanceLoading,
    error: attendanceError,
    addAttendance,
    updateAttendance,
    deleteAttendance,
  } = useAttendance(collectionAccess, employees, employeesLoading);
  const {
    leaves,
    loading: leavesLoading,
    error: leavesError,
    addLeave,
    updateLeaveStatus,
  } = useLeaves(collectionAccess, employees, employeesLoading);
  const {
    payroll,
    loading: payrollLoading,
    error: payrollError,
    addPayroll,
    updatePayrollStatus,
  } = usePayroll(collectionAccess);
  const {
    leaveBalances,
    loading: leaveBalancesLoading,
    error: leaveBalancesError,
  } = useLeaveBalances(collectionAccess);
  const {
    departments,
    loading: departmentsLoading,
    error: departmentsError,
    addDepartment,
    updateDepartment,
    deleteDepartment,
  } = useDepartments(collectionAccess);

  const loading = [
    employeesLoading,
    projectsLoading,
    kpisLoading,
    attendanceLoading,
    leavesLoading,
    payrollLoading,
    leaveBalancesLoading,
    departmentsLoading,
  ].some(Boolean);
  const dataError = [
    employeesError,
    projectsError,
    kpisError,
    attendanceError,
    leavesError,
    payrollError,
    leaveBalancesError,
    departmentsError,
  ].find(Boolean);
  const requestedRoute = getRouteById(routeId);
  const activeRoute = canAccessRoute(user, requestedRoute)
    ? requestedRoute
    : getDefaultRoute(user);

  useEffect(() => {
    setLoading("data", loading);
  }, [loading, setLoading]);

  useEffect(() => {
    if (dataError) {
      reportError("data", dataError);
    } else {
      clearError("data");
    }
  }, [clearError, dataError, reportError]);

  useEffect(() => () => {
    setLoading("data", false);
    clearError("data");
  }, [clearError, setLoading]);

  useEffect(() => {
    if (activeRoute && routeId !== activeRoute.id) {
      navigate(activeRoute.id);
    }
  }, [activeRoute, navigate, routeId]);

  if (loading || !activeRoute) return <LoadingScreen message="Loading data…" />;

  const onLogout = async () => {
    await logout();
    navigate("dashboard");
  };
  const Page = PAGE_COMPONENTS[activeRoute.id];
  const sharedProps = {
    user,
    employees,
    projects,
    kpis,
    attendance,
    leaves,
    payroll,
    leaveBalances,
    departments,
    addEmployee,
    updateEmployee,
    deleteEmployee,
    addProject,
    updateProject,
    deleteProject,
    addKpi,
    updateKpi,
    addAttendance,
    updateAttendance,
    deleteAttendance,
    addLeave,
    updateLeaveStatus,
    addPayroll,
    updatePayrollStatus,
    addDepartment,
    updateDepartment,
    deleteDepartment,
  };

  return (
    <Layout
      user={user}
      page={activeRoute.id}
      setPage={navigate}
      onLogout={onLogout}
    >
      <Suspense fallback={<LoadingScreen message="Loading page…" />}>
        <Page {...sharedProps} />
      </Suspense>
    </Layout>
  );
}

function AppContent() {
  const { routeId, navigate } = useHashNavigation();
  const {
    user,
    authReady,
    seeding,
    reportError,
    clearError,
    setLoading,
    logout,
  } = useApp();
  const principal = useMemo(() => verifiedPrincipalFromUser(user), [user]);

  if (seeding) return <LoadingScreen message="Setting up your database…" />;
  if (!authReady) return <LoadingScreen message="Connecting to Firebase…" />;
  if (!principal) return <LoginPage />;

  const workspaceIdentity = JSON.stringify({
    employeeId: principal.employee.id,
    role: principal.employee.role,
    department: principal.employee.dept,
  });

  return (
    <AuthenticatedWorkspace
      key={workspaceIdentity}
      principal={principal}
      routeId={routeId}
      navigate={navigate}
      reportError={reportError}
      clearError={clearError}
      setLoading={setLoading}
      logout={logout}
    />
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
