import { Router } from "express";
import { createEmployeeController } from "../controllers/employeeController.js";

/**
 * Write routes for /employees -- mounted alongside the read-only router
 * createResourceRouter already provides for the same path (Phase 3). Express dispatches by
 * method as well as path, so a GET-only router and this POST/PATCH/DELETE-only router can
 * both be mounted at "/employees" without conflict.
 *
 * @param {() => object} getEmployeeMutationService - called per-request; see
 *   employeeController.js for why.
 */
export function createEmployeeRouter(getEmployeeMutationService) {
  const router = Router();
  const controller = createEmployeeController(getEmployeeMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}
