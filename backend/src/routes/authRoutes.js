import { Router } from "express";
import { createAuthController } from "../controllers/authController.js";

/**
 * @param {{ getAuthService: () => object, getPasswordSetService: () => object }} getters -
 *   both resolved per-request, not at router-construction time, matching
 *   resourceRoutes.js's getRepository() convention: importing the app must never open a
 *   pool or demand AUTH_TOKEN_SECRET just to build the route tree.
 */
export function createAuthRouter({ getAuthService, getPasswordSetService }) {
  const router = Router();
  const controller = createAuthController({ getAuthService, getPasswordSetService });

  router.post("/login", controller.login);
  router.post("/refresh", controller.refresh);
  router.post("/logout", controller.logout);
  // Public, alongside the other auth routes -- see authController.js's setPassword for why
  // it belongs here rather than under /employees.
  router.post("/set-password", controller.setPassword);

  return router;
}
