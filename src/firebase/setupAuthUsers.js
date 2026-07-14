// src/firebase/setupAuthUsers.js
// ═══════════════════════════════════════════════════════════════════
// ONE-TIME SETUP — Run this ONCE, then delete this file.
//
// What it does:
//   Reads all employees from Firestore and creates a Firebase Auth
//   account (email + password) for each one.
//
// How to run it:
//   1. Temporarily add this to App.jsx useEffect:
//        import { createAuthUsersFromFirestore } from "./firebase/setupAuthUsers";
//        useEffect(() => { createAuthUsersFromFirestore(); }, []);
//   2. Open the app once — check browser console for results.
//   3. Remove the import + useEffect. Delete this file.
// ═══════════════════════════════════════════════════════════════════

import { auth, db } from "./firebaseConfig";
import { createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { getDocs, collection } from "firebase/firestore";

export async function createAuthUsersFromFirestore() {
  console.log("🔧 Starting Firebase Auth user creation…");
  
  const snap = await getDocs(collection(db, "employees"));
  const results = [];

  for (const docSnap of snap.docs) {
    const emp = docSnap.data();

    if (!emp.email || !emp.pass) {
      results.push({ name: emp.name ?? docSnap.id, status: "⚠️  skipped — missing email or pass field" });
      continue;
    }

    try {
      await createUserWithEmailAndPassword(auth, emp.email, emp.pass);
      await signOut(auth); // sign out so next createUserWithEmailAndPassword works
      results.push({ name: emp.name, email: emp.email, status: "✅ created" });
    } catch (err) {
      const status = err.code === "auth/email-already-in-use"
        ? "⚠️  already exists (skip)"
        : `❌ error: ${err.message}`;
      results.push({ name: emp.name, email: emp.email, status });
    }
  }

  console.table(results);
  console.log("✅ Done! Now lock your Firestore rules.");
  return results;
}
