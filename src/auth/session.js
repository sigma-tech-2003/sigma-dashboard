import { authApiService } from "../services/authApiService.js";
import { departmentDirectory } from "../services/departmentDirectory.js";
import { createSessionManager } from "./sessionManager.js";

// THE session of this browser tab. The auth context, authService and authSessionService all share it, which is
// what lets LoginPage (which calls the services directly) and the rest of the app (which reads the context)
// agree on who is signed in.
export const session = createSessionManager({ authApi: authApiService });

// Whatever was learnt about departments belongs to the person who learnt it.
session.subscribe(() => {
  if (!session.getState().user) departmentDirectory.clear();
});
