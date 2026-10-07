import { Router } from "express";
import { createLeaveController } from "../controllers/leaveController.js";

/**
 * Write routes for /leaves -- mounted alongside the read-only router createResourceRouter already
 * provides for the same path (Phase 3), exactly like attendanceRoutes.js and payrollRoutes.js.
 * Express dispatches by method as well as path, so the GET-only router and this
 * POST/PATCH/DELETE-only router coexist without conflict.
 *
 * The balance is NOT here: GET /leaves/:id is already the read router's, so GET /leaves/balance would
 * be swallowed as a malformed id. It lives at /leave-balances (leaveBalanceRoutes.js).
 *
 * @param {() => object} getLeaveMutationService - called per-request; see leaveController.js.
 */
export function createLeaveRouter(getLeaveMutationService) {
  const router = Router();
  const controller = createLeaveController(getLeaveMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.decide);
  router.delete("/:id", controller.remove);

  return router;
}
