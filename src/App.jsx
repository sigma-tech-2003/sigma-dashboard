// src/App.jsx
// ✅ Security v2 — Firebase Auth manages sessions, no localStorage

import { useState, useEffect } from "react";

import { useEmployees, useKpis, useLeaves, usePayroll, useLeaveBalances } from "./firebase/useFirestore";
import { seedAll, isSeeded } from "./firebase/seedFirestore";
import { auth, db } from "./firebase/firebaseConfig";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";
import { createAuthUsersFromFirestore } from "./firebase/setupAuthUsers";

import LoadingScreen from "./components/loading-screen/LoadingScreen";
import Layout        from "./components/layout/Layout";
import LoginPage     from "./pages/login-page/LoginPage";
import Dashboard     from "./pages/dashboard/Dashboard";
import EmployeesPage from "./pages/employees/EmployeesPage";
import KPIPage       from "./pages/kpi/KPIPage";
import LeavePage     from "./pages/leave/LeavePage";
import PayrollPage   from "./pages/payroll/PayrollPage";
import MyPayslipsPage from "./pages/payroll/MyPayslipsPage";


export default function App() {
  const [user,      setUser]      = useState(null);
  const [authReady, setAuthReady] = useState(false); // has Firebase Auth responded?
  const [page,      setPage]      = useState("dashboard");
  const [seeding,   setSeeding]   = useState(false);

  const { employees, loading: loadEmp, addEmployee, updateEmployee, deleteEmployee } = useEmployees();
  const { kpis,     loading: loadKpi, addKpi, updateKpi }                           = useKpis();
  const { leaves,   loading: loadLv,  addLeave, updateLeaveStatus }                 = useLeaves();
  const { payroll,  loading: loadPay, addPayroll, updatePayrollStatus }             = usePayroll();
  const { leaveBalances, loading: loadBal }                                         = useLeaveBalances();
  const loading = loadEmp || loadKpi || loadLv || loadPay || loadBal;

  // ── Seed database on first run ────────────────────────────────────
  // Requires Firestore rules to be OPEN (allow read, write: if true)
  // After seeding + creating Auth users, lock the rules.
  // Once rules are locked, this try/catch silently skips seeding.
  useEffect(() => {
    async function seed() {
      try {
        const seeded = await isSeeded();
        if (!seeded) {
          setSeeding(true);
          await seedAll();
          setSeeding(false);
        }
      } catch {
        setSeeding(false); // rules locked = already seeded, no action needed
      }
    }
    seed();
  }, []);
  useEffect(() => { createAuthUsersFromFirestore(); }, []);

  // ── Firebase Auth session listener ────────────────────────────────
  // This is the ONLY auth truth. No localStorage. Firebase handles sessions.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Find the employee record that matches this Firebase Auth email
          const q    = query(collection(db, "employees"), where("email", "==", firebaseUser.email));
          const snap = await getDocs(q);

          if (!snap.empty) {
            setUser(snap.docs[0].data()); // role comes from Firestore, not from client
          } else {
            // Firebase user exists but no matching employee — sign them out
            await signOut(auth);
            setUser(null);
          }
        } catch {
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
  if (!user)             return <LoginPage />;   // no props needed anymore
  if (loading)           return <LoadingScreen message="Loading data…"             />;

  // ── Logout ────────────────────────────────────────────────────────
  const onLogout = async () => {
    await signOut(auth);
    setUser(null);
    setPage("dashboard");
  };

  const isAdminOrHR = user.role === "admin" || user.role === "hr";

  const sharedProps = {
    user, employees, kpis, leaves, payroll, leaveBalances,
    addEmployee, updateEmployee, deleteEmployee,
    addKpi, updateKpi,
    addLeave, updateLeaveStatus,
    addPayroll, updatePayrollStatus,
  };

  return (
    <Layout user={user} page={page} setPage={setPage} onLogout={onLogout}>
      {page === "dashboard"                              && <Dashboard     {...sharedProps} />}
      {page === "employees" && isAdminOrHR              && <EmployeesPage {...sharedProps} />}
      {page === "kpi"                                   && <KPIPage       {...sharedProps} />}
      {page === "leave"                                 && <LeavePage     {...sharedProps} />}
      {page === "payroll"   && isAdminOrHR              && <PayrollPage   {...sharedProps} />}
      {page === "payslips"  && user.role === "employee" && <MyPayslipsPage {...sharedProps} />}
    </Layout>
  );
}
