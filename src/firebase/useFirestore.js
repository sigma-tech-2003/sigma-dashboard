// src/firebase/useFirestore.js
import { useState, useEffect, useCallback } from "react";
import { db, auth } from "./firebaseConfig";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  getDocs,
} from "firebase/firestore";

// ─── Generic collection listener ───────────────────────────────────────────
function useCollection(collectionName, orderByField = null) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubFirestore = null;

    // ✅ Pehle Auth ready hone ka wait karo, phir data load karo
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        const ref = collection(db, collectionName);
        const q = orderByField ? query(ref, orderBy(orderByField)) : ref;

        unsubFirestore = onSnapshot(q, (snap) => {
          setData(snap.docs.map((d) => ({ ...d.data(), _docId: d.id })));
          setLoading(false);
        });
      } else {
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

  const setEmployees = useCallback(async (updater) => {
    if (typeof updater === "function") {
      console.warn("useEmployees: use addEmployee/updateEmployee/deleteEmployee instead");
    }
  }, []);

  return { employees, loading, addEmployee, updateEmployee, deleteEmployee, setEmployees };
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

  const setKpis = useCallback((updater) => {
    if (typeof updater === "function") {
      console.warn("useKpis: use addKpi/updateKpi directly.");
    }
  }, []);

  return { kpis, loading, addKpi, updateKpi, setKpis };
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

  const setLeaves = useCallback((updater) => {
    if (typeof updater === "function") {
      console.warn("useLeaves: use addLeave/updateLeaveStatus directly.");
    }
  }, []);

  return { leaves, loading, addLeave, updateLeaveStatus, setLeaves };
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

  const setPayroll = useCallback((updater) => {
    if (typeof updater === "function") {
      console.warn("usePayroll: use addPayroll/updatePayrollStatus directly.");
    }
  }, []);

  return { payroll, loading, addPayroll, updatePayrollStatus, setPayroll };
}

// ─── LEAVE BALANCES ─────────────────────────────────────────────────────────
export function useLeaveBalances() {
  const [leaveBalances, setLeaveBalances] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubFirestore = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubFirestore = onSnapshot(collection(db, "leaveBalances"), (snap) => {
          const obj = {};
          snap.docs.forEach((d) => {
            obj[d.id] = d.data();
          });
          setLeaveBalances(obj);
          setLoading(false);
        });
      } else {
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