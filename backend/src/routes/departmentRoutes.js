import { Router } from "express";
import { createDepartmentController } from "../controllers/departmentController.js";

/**
 * Write routes for /departments -- mounted alongside the read-only router
 * createResourceRouter already provides for the same path (Phase 3), exactly like
 * employeeRoutes.js. Express dispatches by method as well as path, so the GET-only router
 * and this POST/PATCH/DELETE-only router coexist without conflict.
 *
 * @param {() => object} getDepartmentMutationService - called per-request; see
 *   departmentController.js for why.
 */
export function createDepartmentRouter(getDepartmentMutationService) {
  const router = Router();
  const controller = createDepartmentController(getDepartmentMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}
