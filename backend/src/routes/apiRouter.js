import { Router } from "express";
import { verifyAccessToken } from "../container.js";
import { createAuthenticationMiddleware } from "../middleware/authentication.js";
import { healthRouter } from "./healthRoutes.js";

/**
 * @param {{ verifyAccessToken?: (token: string) => Promise<object> }} [dependencies]
 */
export function createApiRouter(dependencies = {}) {
  const router = Router();

  // Health is deliberately public: it must answer before anyone can authenticate, and a
  // readiness probe has no credentials.
  router.use(healthRouter);

  // Everything mounted after this line requires a bearer token. The middleware sets
  // req.principal, resolved from the database on every request, so a deactivated account
  // is rejected immediately rather than at token expiry (decision D10).
  router.use(createAuthenticationMiddleware({
    verifyAccessToken: dependencies.verifyAccessToken ?? verifyAccessToken,
  }));

  // Authenticated routes are added here as each domain cuts over in Phases 5-9.

  return router;
}

export const apiRouter = createApiRouter();
