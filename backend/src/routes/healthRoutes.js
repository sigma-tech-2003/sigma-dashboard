import { Router } from "express";
import { healthCheck } from "../controllers/healthController.js";

export const healthRouter = Router();
healthRouter.get("/health", healthCheck);
