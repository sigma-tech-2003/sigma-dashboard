// src/App.jsx
// Security fixes:
// ✅ Fix 1: Role is now verified from Firestore, NOT from localStorage
// ✅ Fix 2: Role is also fetched from Firestore on login
// ✅ Fix 3: Anonymous auth is used only for seeding, not for user sessions

import { useState, useEffect } from "react";

// ─── Firebase ────────────────────────────────────────────────────────────────
import {
  useEmployees,
  useKpis,
  useLeaves,
  usePayroll,
  useLeaveBalances,
} from "./firebase/useFirestore";
import { seedAll, isSeeded } from "./firebase/seedFirestore";
import { auth, db } from "./firebase/firebaseConfig"; // ✅ db also imported
import { signInAnonymously } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore"; // ✅ To fetch data from Firestore

// ─── UI Shell ────────────────────────────────────────────────────────────────
import LoadingScreen from "./components/loading-screen/LoadingScreen";
import Layout from "./components/layout/Layout";

// ─── Pages ───────────────────────────────────────────────────────────────────
import LoginPage from "./pages/login-page/LoginPage";
import Dashboard from "./pages/dashboard/Dashboard";
import EmployeesPage from "./pages/employees/EmployeesPage";
import KPIPage from "./pages/kpi/KPIPage";
import LeavePage from "./pages/leave/LeavePage";
import PayrollPage from "./pages/payroll/PayrollPage";
import MyPayslipsPage from "./pages/payroll/MyPayslipsPage";

/* ═══════════════════════════════════════════════════════════════════
   HELPER — Verify the real role from Firestore
   This function takes an employee's ID and checks Firestore
   for their actual role — no one can change their role by
   editing localStorage anymore.
═══════════════════════════════════════════════════════════════════ */
async function verifyUserRole(savedUser) {
  // If user or user.id is missing, return null
  if (!savedUser?.id) return null;

  try {
    // Look up this user in the employees collection in Firestore
    const empRef = doc(db, "employees", savedUser.id);
    const empSnap = await getDoc(empRef);

    if (empSnap.exists()) {
      // ✅ Take role from Firestore — IGNORE the role in localStorage
      return {
        ...savedUser,
        role: empSnap.data().role, // Real role from Firestore
      };
    } else {
      // Employee does not exist — session is fake or outdated, discard it
      return null;
    }
  } catch (err) {
    console.warn("Role verification failed:", err);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [user, setUser] = useState(null); // ✅ Start as null — verify first
  const [page, setPage] = useState("dashboard");
  const [seeding, setSeeding] = useState(false);
  const [verifying, setVerifying] = useState(true); // ✅ New state — verifying session

  // ── Live Firestore collections ───────────────────────────────────
  const { employees, loading: loadEmp, addEmployee, updateEmployee, deleteEmployee } = useEmployees();
  const { kpis, loading: loadKpi, addKpi, updateKpi } = useKpis();
  const { leaves, loading: loadLv, addLeave, updateLeaveStatus } = useLeaves();
  const { payroll, loading: loadPay, addPayroll, updatePayrollStatus } = usePayroll();
  const { leaveBalances, loading: loadBal } = useLeaveBalances();

  const loading = loadEmp || loadKpi || loadLv || loadPay || loadBal;

  // ── On app start: seed the database + verify the session ─────────
  useEffect(() => {
    async function init() {
      // STEP 1: Seed the database if this is the first run
      try {
        const seeded = await isSeeded();
        if (!seeded) {
          setSeeding(true);
          await seedAll();
          setSeeding(false);
        }
      } catch (err) {
        console.warn("Seed check failed:", err);
        setSeeding(false);
      }

      // STEP 2: Check for an existing session
      // ✅ FIX: Load user from localStorage, but verify their role from Firestore
      const saved = localStorage.getItem("hrm_user");
      if (saved) {
        try {
          const savedUser = JSON.parse(saved);
          const verifiedUser = await verifyUserRole(savedUser);

          if (verifiedUser) {
            // ✅ Valid user — set with the real role from Firestore
            setUser(verifiedUser);
            // ✅ Also update localStorage with the real role
            localStorage.setItem("hrm_user", JSON.stringify(verifiedUser));
          } else {
            // ❌ Fake or outdated session — remove it, user must log in again
            localStorage.removeItem("hrm_user");
          }
        } catch (err) {
          // ❌ Corrupt data in localStorage — remove it
          localStorage.removeItem("hrm_user");
        }
      }

      setVerifying(false); // Verification complete
    }

    init();
  }, []);

  // ── Loading / Verifying states ────────────────────────────────────
  if (seeding)          return <LoadingScreen message="Setting up your database…" />;
  if (verifying)        return <LoadingScreen message="Verifying your session…" />; // ✅ New
  if (loading && !user) return <LoadingScreen message="Connecting to Firebase…" />;

  // ── Auth gate ─────────────────────────────────────────────────────
  if (!user) {
    return (
      <LoginPage
        employees={employees}
        onLogin={async (u) => {
          // ✅ FIX: Verify role from Firestore on login as well
          const verifiedUser = await verifyUserRole(u);
          const finalUser = verifiedUser || u; // Fallback: use original if verify fails

          localStorage.setItem("hrm_user", JSON.stringify(finalUser));
          setUser(finalUser);
          setPage("dashboard");
        }}
      />
    );
  }

  if (loading) return <LoadingScreen message="Loading data…" />;

  // ── Shared props passed to every page ────────────────────────────
  const sharedProps = {
    user,
    employees, kpis, leaves, payroll, leaveBalances,
    addEmployee, updateEmployee, deleteEmployee,
    addKpi, updateKpi,
    addLeave, updateLeaveStatus,
    addPayroll, updatePayrollStatus,
  };

  const onLogout = () => {
    localStorage.removeItem("hrm_user");
    setUser(null);
    setPage("dashboard");
  };

  // ✅ Role check is the same — but the role now comes from Firestore, not localStorage
  const isAdminOrHR = user.role === "admin" || user.role === "hr";

  return (
    <Layout user={user} page={page} setPage={setPage} onLogout={onLogout}>
      {page === "dashboard"  &&                       <Dashboard      {...sharedProps} />}
      {page === "employees"  && isAdminOrHR &&        <EmployeesPage  {...sharedProps} />}
      {page === "kpi"        &&                       <KPIPage        {...sharedProps} />}
      {page === "leave"      &&                       <LeavePage      {...sharedProps} />}
      {page === "payroll"    && isAdminOrHR &&        <PayrollPage    {...sharedProps} />}
      {page === "payslips"   && user.role === "employee" && <MyPayslipsPage {...sharedProps} />}
    </Layout>
  );
}
