// src/firebase/seedFirestore.js
// Run this ONCE to populate your Firestore with initial data.
// Call seedAll() from a button or useEffect on first load, then remove it.

import { createDocument, hasDocuments } from "../services/firestoreService";
import { INIT_EMPLOYEES } from "../data/employees";
import { INIT_KPIS } from "../data/kpis";
import { INIT_LEAVES } from "../data/leaves";
import { INIT_PAYROLL } from "../data/payroll";
import { LEAVE_BAL } from "../data/leaveBalance";

export async function seedAll() {
  // Seed employees
  for (const emp of INIT_EMPLOYEES) {
    await createDocument("employees", emp.id, emp);
  }

  // Seed KPIs
  for (const kpi of INIT_KPIS) {
    await createDocument("kpis", kpi.id, kpi);
  }

  // Seed leaves
  for (const leave of INIT_LEAVES) {
    await createDocument("leaves", leave.id, leave);
  }

  // Seed payroll
  for (const pay of INIT_PAYROLL) {
    await createDocument("payroll", pay.id, pay);
  }

  // Seed leave balances (stored as a single doc per employee)
  for (const [empId, balances] of Object.entries(LEAVE_BAL)) {
    await createDocument("leaveBalances", empId, balances);
  }

  console.log("✅ Firestore seeded successfully!");
}

// Check if already seeded
export async function isSeeded() {
  return hasDocuments("employees");
}
