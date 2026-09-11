import cors from "cors";
import express from "express";
import helmet from "helmet";
import { environment } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/requestId.js";
import { apiRouter, createApiRouter } from "./routes/apiRouter.js";

const isAllowedOrigin = (origin) => !origin || environment.corsAllowedOrigins.includes(origin);

/**
 * @param {{ verifyAccessToken?: (token: string) => Promise<object> }} [dependencies]
 *   Supplying verifyAccessToken builds a router with that verifier, which is how tests
 *   exercise the authentication boundary without a database.
 */
export function createApp(dependencies = {}) {
  const app = express();
  const router = dependencies.verifyAccessToken ? createApiRouter(dependencies) : apiRouter;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  }));
  app.use(express.json({ limit: "100kb" }));
  app.use(requestId);
  app.use("/api/v1", router);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
