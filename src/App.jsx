// src/App.jsx
// ✅ Security v2 — Firebase Auth manages sessions, no localStorage
// ✅ Perf v3 — pages are code-split (React.lazy), seeding only runs after auth

import { useState, useEffect, useRef, lazy, Suspense } from "react";

import { useEmployees, useKpis, useLeaves, usePayroll, useLeaveBalances } from "./firebase/useFirestore";
import { useDepartments } from "./firebase/useDepartments";
import { seedAll, isSeeded } from "./firebase/seedFirestore";
import { auth, db } from "./firebase/firebaseConfig";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";

import LoadingScreen from "./components/loading-screen/LoadingScreen";
import Layout        from "./components/layout/Layout";
import LoginPage     from "./pages/login-page/LoginPage";

// Code-split pages — each loads only when first visited
const Dashboard       = lazy(() => import("./pages/dashboard/Dashboard"));
const EmployeesPage   = lazy(() => import("./pages/employees/EmployeesPage"));
const DepartmentsPage = lazy(() => import("./pages/departments/DepartmentsPage"));
const KPIPage         = lazy(() => import("./pages/kpi/KPIPage"));
const LeavePage       = lazy(() => import("./pages/leave/LeavePage"));
const PayrollPage     = lazy(() => import("./pages/payroll/PayrollPage"));
const MyPayslipsPage  = lazy(() => import("./pages/payroll/MyPayslipsPage"));

export default function App() {
  const [user,      setUser]      = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [page,      setPage]      = useState("dashboard");
  const [seeding,   setSeeding]   = useState(false);
  const seedChecked = useRef(false);

  const { employees,    loading: loadEmp, addEmployee, updateEmployee, deleteEmployee } = useEmployees();
  const { kpis,         loading: loadKpi, addKpi, updateKpi }                          = useKpis();
  const { leaves,       loading: loadLv,  addLeave, updateLeaveStatus }                = useLeaves();
  const { payroll,      loading: loadPay, addPayroll, updatePayrollStatus }            = usePayroll();
  const { leaveBalances,loading: loadBal }                                             = useLeaveBalances();
  const { departments,  loading: loadDept, addDepartment, updateDepartment, deleteDepartment } = useDepartments();

  const loading = loadEmp || loadKpi || loadLv || loadPay || loadBal || loadDept;

  // ── Firebase Auth session listener ────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Seed on first authenticated session only (locked Firestore rules
          // block unauthenticated writes, so seeding pre-auth never worked)
          if (!seedChecked.current) {
            seedChecked.current = true;
            if (!(await isSeeded())) {
              setSeeding(true);
              await seedAll();
              setSeeding(false);
            }
          }

          const q    = query(collection(db, "employees"), where("email", "==", firebaseUser.email));
          const snap = await getDocs(q);
          if (!snap.empty) {
            setUser(snap.docs[0].data());
          } else {
            await signOut(auth);
            setUser(null);
          }
        } catch {
          setSeeding(false);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // ── Guards ────────────────────────────────────────────────────────
  if (seeding)           return <LoadingScreen message="Setting up your database…" />;
  if (!authReady)        return <LoadingScreen message="Connecting to Firebase…"   />;
  if (loading && !user)  return <LoadingScreen message="Loading data…"             />;
  if (!user)             return <LoginPage />;
  if (loading)           return <LoadingScreen message="Loading data…"             />;

  // ── Logout ────────────────────────────────────────────────────────
  const onLogout = async () => {
    await signOut(auth);
    setUser(null);
    setPage("dashboard");
  };

  const isAdminOrHR   = user.role === "admin" || user.role === "hr";
  // Employees page is shared by every managerial role — each role only
  // sees/edits the slice of employees permissions.js scopes them to.
  const canSeeEmployees = ["admin", "hr", "manager", "tl"].includes(user.role);

  const sharedProps = {
    user,
    employees, kpis, leaves, payroll, leaveBalances, departments,
    addEmployee, updateEmployee, deleteEmployee,
    addKpi, updateKpi,
    addLeave, updateLeaveStatus,
    addPayroll, updatePayrollStatus,
    addDepartment, updateDepartment, deleteDepartment,
  };

  return (
    <Layout user={user} page={page} setPage={setPage} onLogout={onLogout}>
      <Suspense fallback={<LoadingScreen message="Loading page…" />}>
        {page === "dashboard"                               && <Dashboard       {...sharedProps} />}
        {page === "employees"   && canSeeEmployees          && <EmployeesPage   {...sharedProps} />}
        {page === "departments" && isAdminOrHR              && <DepartmentsPage {...sharedProps} />}
        {page === "kpi"                                     && <KPIPage         {...sharedProps} />}
        {page === "leave"                                   && <LeavePage       {...sharedProps} />}
        {page === "payroll"     && isAdminOrHR              && <PayrollPage     {...sharedProps} />}
        {page === "payslips"    && user.role === "employee" && <MyPayslipsPage  {...sharedProps} />}
      </Suspense>
    </Layout>
  );
}
