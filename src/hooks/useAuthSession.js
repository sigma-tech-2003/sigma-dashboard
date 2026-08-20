import { useEffect, useRef, useState } from "react";
import { isSeeded, seedAll } from "../firebase/seedFirestore";
import { observeAuthState, signOutUser } from "../services/authService";
import { findEmployeeByEmail } from "../services/firestoreService";

export const AUTH_ROLE_STORAGE_KEY = "sigma-hrm-selected-role";
export const AUTH_ROLE_ERROR_STORAGE_KEY = "sigma-hrm-role-error";
export const AUTH_ROLE_MISMATCH_MESSAGE = "These credentials do not belong to the selected role.";

export function useAuthSession() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const seedChecked = useRef(false);

  useEffect(() => {
    const unsubscribe = observeAuthState(async (firebaseUser) => {
      if (firebaseUser) {
        setUser(null);
        try {
          if (!seedChecked.current) {
            seedChecked.current = true;
            if (!(await isSeeded())) {
              setSeeding(true);
              await seedAll();
              setSeeding(false);
            }
          }

          const employee = await findEmployeeByEmail(firebaseUser.email);
          const selectedRole = sessionStorage.getItem(AUTH_ROLE_STORAGE_KEY);

          if (employee && selectedRole && employee.role === selectedRole) {
            setUser(employee);
          } else {
            setUser(null);
            const signOutPromise = signOutUser();
            sessionStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
            sessionStorage.setItem(AUTH_ROLE_ERROR_STORAGE_KEY, AUTH_ROLE_MISMATCH_MESSAGE);
            await signOutPromise;
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

    return unsubscribe;
  }, []);

  return { user, authReady, seeding };
}
