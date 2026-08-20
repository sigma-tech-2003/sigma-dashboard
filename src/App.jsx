import { lazy, Suspense, useEffect } from "react";
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
  useEmployees,
  useKpis,
  useLeaveBalances,
  useLeaves,
  usePayroll,
  useProjects,
} from "./firebase/useFirestore";
import { useHashNavigation } from "./hooks/useHashNavigation";
import LoginPage from "./pages/login-page/LoginPage";

const PAGE_COMPONENTS = Object.fromEntries(
  APP_ROUTES.map((route) => [route.id, lazy(route.load)]),
);

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

  const {
    employees,
    loading: employeesLoading,
    error: employeesError,
    addEmployee,
    updateEmployee,
    deleteEmployee,
  } = useEmployees();
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    addProject,
    updateProject,
    deleteProject,
  } = useProjects();
  const {
    kpis,
    loading: kpisLoading,
    error: kpisError,
    addKpi,
    updateKpi,
  } = useKpis();
  const {
    leaves,
    loading: leavesLoading,
    error: leavesError,
    addLeave,
    updateLeaveStatus,
  } = useLeaves();
  const {
    payroll,
    loading: payrollLoading,
    error: payrollError,
    addPayroll,
    updatePayrollStatus,
  } = usePayroll();
  const {
    leaveBalances,
    loading: leaveBalancesLoading,
    error: leaveBalancesError,
  } = useLeaveBalances();
  const {
    departments,
    loading: departmentsLoading,
    error: departmentsError,
    addDepartment,
    updateDepartment,
    deleteDepartment,
  } = useDepartments();

  const loading = [
    employeesLoading,
    projectsLoading,
    kpisLoading,
    leavesLoading,
    payrollLoading,
    leaveBalancesLoading,
    departmentsLoading,
  ].some(Boolean);
  const dataError = [
    employeesError,
    projectsError,
    kpisError,
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

  useEffect(() => {
    if (activeRoute && routeId !== activeRoute.id) {
      navigate(activeRoute.id);
    }
  }, [activeRoute, navigate, routeId]);

  if (seeding) return <LoadingScreen message="Setting up your database…" />;
  if (!authReady) return <LoadingScreen message="Connecting to Firebase…" />;
  if (loading && !user) return <LoadingScreen message="Loading data…" />;
  if (!user) return <LoginPage />;
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

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
