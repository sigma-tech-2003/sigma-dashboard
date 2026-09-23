import { Router } from "express";
import { createAuthController } from "../controllers/authController.js";

/**
 * @param {() => object} getAuthService - resolved per-request, not at router-construction
 *   time, matching resourceRoutes.js's getRepository() convention: importing the app must
 *   never open a pool or demand AUTH_TOKEN_SECRET just to build the route tree.
 */
export function createAuthRouter(getAuthService) {
  const router = Router();
  const controller = createAuthController(getAuthService);

  router.post("/login", controller.login);
  router.post("/refresh", controller.refresh);
  router.post("/logout", controller.logout);

  return router;
}
