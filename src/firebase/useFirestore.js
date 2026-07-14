// src/firebase/useFirestore.js
// ✅ Auth-aware: Firestore listeners only start after Firebase Auth confirms a user.
//    No auth = no data. This works with the locked Firestore rules below.

import { useState, useEffect, useCallback } from "react";
import { db, auth } from "./firebaseConfig";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection, onSnapshot, doc, setDoc,
  updateDoc, deleteDoc, query, orderBy,
} from "firebase/firestore";

// ─── Generic auth-aware collection listener ─────────────────────────────────
function useCollection(collectionName, orderByField = null) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubFirestore = null;

    const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
      // Always clean up previous Firestore listener before starting a new one
      if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }

      if (firebaseUser) {
        // User is logged in — start listening to Firestore
        const ref = collection(db, collectionName);
        const q   = orderByField ? query(ref, orderBy(orderByField)) : ref;
        unsubFirestore = onSnapshot(q, (snap) => {
          setData(snap.docs.map((d) => ({ ...d.data(), _docId: d.id })));
          setLoading(false);
        });
      } else {
        // User is logged out — clear data
        setData([]);
        setLoading(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubFirestore) unsubFirestore();
    };
  }, [collectionName, orderByField]);

  return { data, loading };
}

// ─── EMPLOYEES ──────────────────────────────────────────────────────────────
export function useEmployees() {
  const { data: employees, loading } = useCollection("employees");

  const addEmployee = useCallback(async (emp) => {
    const id = Date.now();
    await setDoc(doc(db, "employees", String(id)), { ...emp, id });
    return id;
  }, []);

  const updateEmployee = useCallback(async (id, updates) => {
    await updateDoc(doc(db, "employees", String(id)), updates);
  }, []);

  const deleteEmployee = useCallback(async (id) => {
    await deleteDoc(doc(db, "employees", String(id)));
  }, []);

  return { employees, loading, addEmployee, updateEmployee, deleteEmployee };
}

// ─── KPIs ───────────────────────────────────────────────────────────────────
export function useKpis() {
  const { data: kpis, loading } = useCollection("kpis");

  const addKpi = useCallback(async (kpi) => {
    const id = Date.now();
    await setDoc(doc(db, "kpis", String(id)), { ...kpi, id });
  }, []);

  const updateKpi = useCallback(async (id, updates) => {
    await updateDoc(doc(db, "kpis", String(id)), updates);
  }, []);

  return { kpis, loading, addKpi, updateKpi };
}

// ─── LEAVES ─────────────────────────────────────────────────────────────────
export function useLeaves() {
  const { data: leaves, loading } = useCollection("leaves");

  const addLeave = useCallback(async (leave) => {
    const id = Date.now();
    await setDoc(doc(db, "leaves", String(id)), { ...leave, id });
  }, []);

  const updateLeaveStatus = useCallback(async (id, status) => {
    await updateDoc(doc(db, "leaves", String(id)), { status });
  }, []);

  return { leaves, loading, addLeave, updateLeaveStatus };
}

// ─── PAYROLL ────────────────────────────────────────────────────────────────
export function usePayroll() {
  const { data: payroll, loading } = useCollection("payroll");

  const addPayroll = useCallback(async (entry) => {
    const id = Date.now();
    await setDoc(doc(db, "payroll", String(id)), { ...entry, id });
  }, []);

  const updatePayrollStatus = useCallback(async (id, status) => {
    await updateDoc(doc(db, "payroll", String(id)), { status });
  }, []);

  return { payroll, loading, addPayroll, updatePayrollStatus };
}

// ─── LEAVE BALANCES ─────────────────────────────────────────────────────────
export function useLeaveBalances() {
  const [leaveBalances, setLeaveBalances] = useState({});
  const [loading,       setLoading]       = useState(true);

  useEffect(() => {
    let unsubFirestore = null;

    const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }

      if (firebaseUser) {
        unsubFirestore = onSnapshot(collection(db, "leaveBalances"), (snap) => {
          const obj = {};
          snap.docs.forEach((d) => { obj[d.id] = d.data(); });
          setLeaveBalances(obj);
          setLoading(false);
        });
      } else {
        setLeaveBalances({});
        setLoading(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubFirestore) unsubFirestore();
    };
  }, []);

  return { leaveBalances, loading };
}