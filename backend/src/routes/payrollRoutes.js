import { Router } from "express";
import { createPayrollController } from "../controllers/payrollController.js";

/**
 * Write routes for /payroll -- mounted alongside the read-only router createResourceRouter
 * already provides for the same path (Phase 3), exactly like attendanceRoutes.js. Express
 * dispatches by method as well as path, so the GET-only router and this POST/PATCH/DELETE-only
 * router coexist without conflict.
 *
 * @param {() => object} getPayrollMutationService - called per-request; see
 *   payrollController.js for why.
 */
export function createPayrollRouter(getPayrollMutationService) {
  const router = Router();
  const controller = createPayrollController(getPayrollMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}
