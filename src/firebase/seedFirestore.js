// src/firebase/seedFirestore.js
// Run this ONCE to populate your Firestore with initial data.
// Call seedAll() from a button or useEffect on first load, then remove it.

import { db } from "./firebaseConfig";
import { collection, doc, setDoc, getDocs } from "firebase/firestore";
import { INIT_EMPLOYEES } from "../data/employees";
import { INIT_KPIS } from "../data/kpis";
import { INIT_LEAVES } from "../data/leaves";
import { INIT_PAYROLL } from "../data/payroll";
import { LEAVE_BAL } from "../data/leaveBalance";

export async function seedAll() {
  // Seed employees
  for (const emp of INIT_EMPLOYEES) {
    await setDoc(doc(db, "employees", String(emp.id)), emp);
  }

  // Seed KPIs
  for (const kpi of INIT_KPIS) {
    await setDoc(doc(db, "kpis", String(kpi.id)), kpi);
  }

  // Seed leaves
  for (const leave of INIT_LEAVES) {
    await setDoc(doc(db, "leaves", String(leave.id)), leave);
  }

  // Seed payroll
  for (const pay of INIT_PAYROLL) {
    await setDoc(doc(db, "payroll", String(pay.id)), pay);
  }

  // Seed leave balances (stored as a single doc per employee)
  for (const [empId, balances] of Object.entries(LEAVE_BAL)) {
    await setDoc(doc(db, "leaveBalances", String(empId)), balances);
  }

  console.log("✅ Firestore seeded successfully!");
}

// Check if already seeded
export async function isSeeded() {
  const snap = await getDocs(collection(db, "employees"));
  return !snap.empty;
}