import { Router } from "express";
import { createKpiController } from "../controllers/kpiController.js";

/**
 * Write routes for /kpis -- mounted alongside the read-only router createResourceRouter already
 * provides for the same path. Express dispatches by method as well as path, so the GET-only router
 * and this one coexist: `GET /kpis/:id` and `POST /kpis/:id/rating` never meet.
 *
 * Rating is POST, not PUT, so the CORS method list in app.js does not have to change (D29).
 *
 * @param {() => object} getKpiMutationService - called per-request; see kpiController.js.
 */
export function createKpiRouter(getKpiMutationService) {
  const router = Router();
  const controller = createKpiController(getKpiMutationService);

  router.post("/", controller.create);
  router.patch("/:id", controller.update);
  router.post("/:id/rating", controller.rate);
  router.delete("/:id", controller.remove);

  return router;
}
