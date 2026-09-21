import { Router } from "express";
import { createResourceController } from "../controllers/resourceController.js";

/**
 * @param {() => object} getRepository - called per-request; must return an object exposing
 *   listForPrincipal(principal) and findByIdForPrincipal(id, principal). Every Phase 3
 *   repository does. Deferred so building the router never touches a database (see
 *   resourceController.js).
 * @param {{ resourceName: string }} options - used only in the 404 message.
 */
export function createResourceRouter(getRepository, options) {
  const router = Router();
  const controller = createResourceController(getRepository, options);
  router.get("/", controller.list);
  router.get("/:id", controller.getById);
  return router;
}
