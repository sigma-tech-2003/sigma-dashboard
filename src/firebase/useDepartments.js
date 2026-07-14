// src/firebase/useDepartments.js
// Same auth-aware pattern as useFirestore.js

import { useState, useEffect, useCallback } from "react";
import { db, auth } from "./firebaseConfig";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection, onSnapshot, doc, setDoc, updateDoc, deleteDoc,
} from "firebase/firestore";

export function useDepartments() {
  const [departments, setDepartments] = useState([]);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    let unsubFirestore = null;

    const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }

      if (firebaseUser) {
        unsubFirestore = onSnapshot(collection(db, "departments"), (snap) => {
          setDepartments(snap.docs.map((d) => ({ ...d.data(), _docId: d.id })));
          setLoading(false);
        });
      } else {
        setDepartments([]);
        setLoading(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubFirestore) unsubFirestore();
    };
  }, []);

  const addDepartment = useCallback(async (dept) => {
    const id = Date.now();
    await setDoc(doc(db, "departments", String(id)), {
      ...dept,
      id,
      createdAt: new Date().toISOString(),
    });
    return id;
  }, []);

  const updateDepartment = useCallback(async (id, updates) => {
    await updateDoc(doc(db, "departments", String(id)), updates);
  }, []);

  const deleteDepartment = useCallback(async (id) => {
    await deleteDoc(doc(db, "departments", String(id)));
  }, []);

  return { departments, loading, addDepartment, updateDepartment, deleteDepartment };
}
