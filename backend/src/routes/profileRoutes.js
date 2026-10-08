import { Router } from "express";
import { createProfileController } from "../controllers/profileController.js";

/**
 * GET /auth/me -- the caller's own profile (D32).
 *
 * Mounted at `/auth`, like authRoutes.js, but a SEPARATE router placed AFTER the authentication
 * middleware in apiRouter.js. login, refresh, logout and set-password are public because the caller
 * has no bearer token yet; this one needs one. An unauthenticated GET /auth/me falls through the
 * public router (it has no such route) and is stopped by the middleware with a 401.
 *
 * @param {() => object} getProfileService - called per-request; see profileController.js.
 */
export function createProfileRouter(getProfileService) {
  const router = Router();
  const controller = createProfileController(getProfileService);

  router.get("/me", controller.me);

  return router;
}
