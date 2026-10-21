import { Router } from "express";
import { createAuthController } from "../controllers/authController.js";

/**
 * POST /auth/change-password (D41).
 *
 * Mounted at `/auth`, like authRoutes.js and profileRoutes.js, but a SEPARATE router placed AFTER the authentication
 * middleware in apiRouter.js: it needs a bearer token (login, refresh and logout are public because the caller has
 * none yet). It is also one of exactly two routes a flagged account may use while must_change_password is true; the
 * other is GET /auth/me. See middleware/authentication.js.
 *
 * @param {{ getAuthService: () => object, getPasswordService: () => object }} getters - resolved per request, like
 *   every other getter in this codebase, so importing the app never opens a pool or demands AUTH_TOKEN_SECRET.
 */
export function createPasswordRouter({ getAuthService, getPasswordService }) {
  const router = Router();
  const controller = createAuthController({ getAuthService, getPasswordService });

  router.post("/change-password", controller.changePassword);

  return router;
}
