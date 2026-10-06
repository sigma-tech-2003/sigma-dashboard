import { Router } from "express";
import { createProjectController } from "../controllers/projectController.js";

/**
 * Write routes for /projects -- mounted alongside the read-only router createResourceRouter
 * already provides for the same path (Phase 3), exactly like attendanceRoutes.js and
 * payrollRoutes.js. Express dispatches by method as well as path, so the GET-only router and this
 * POST/PATCH/DELETE-only router coexist without conflict.
 *
 * @param {() => object} getProjectMutationService - called per-request; see projectController.js.
 */
export function createProjectRouter(getProjectMutationService) {
  const router = Router();
  const controller = createProjectController(getProjectMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}
