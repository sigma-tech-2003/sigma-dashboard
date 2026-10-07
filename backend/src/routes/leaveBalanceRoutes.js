import { Router } from "express";
import { createLeaveBalanceController } from "../controllers/leaveBalanceController.js";

/**
 * GET /leave-balances -- an employee's balance, computed from `leaves` (D4, D31). Its own path, named
 * for the Firestore collection it replaces, because /leaves/balance would collide with the read
 * router's GET /leaves/:id.
 *
 * @param {() => object} getLeaveBalanceService - called per-request; see leaveBalanceController.js.
 */
export function createLeaveBalanceRouter(getLeaveBalanceService) {
  const router = Router();
  const controller = createLeaveBalanceController(getLeaveBalanceService);

  router.get("/", controller.get);

  return router;
}
