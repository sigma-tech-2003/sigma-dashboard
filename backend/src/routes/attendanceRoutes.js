import { Router } from "express";
import { createAttendanceController } from "../controllers/attendanceController.js";

/**
 * Write routes for /attendance -- mounted alongside the read-only router
 * createResourceRouter already provides for the same path (Phase 3), exactly like
 * departmentRoutes.js. Express dispatches by method as well as path, so the GET-only router
 * and this POST/PATCH/DELETE-only router coexist without conflict.
 *
 * @param {() => object} getAttendanceMutationService - called per-request; see
 *   attendanceController.js for why.
 */
export function createAttendanceRouter(getAttendanceMutationService) {
  const router = Router();
  const controller = createAttendanceController(getAttendanceMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}
