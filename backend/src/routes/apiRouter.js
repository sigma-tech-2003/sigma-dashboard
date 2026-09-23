import { Router } from "express";
import { getContainer, verifyAccessToken } from "../container.js";
import { createAuthenticationMiddleware } from "../middleware/authentication.js";
import { createAuthRouter } from "./authRoutes.js";
import { healthRouter } from "./healthRoutes.js";
import { createResourceRouter } from "./resourceRoutes.js";

// Phase 3: read-only. Every entry becomes a `GET /<path>` and `GET /<path>/:id` pair via
// createResourceRouter -- see src/controllers/resourceController.js for why one factory
// serves all seven rather than seven near-identical files. Writes are not part of this
// phase; they land per domain in Phases 5-9.
const RESOURCE_ROUTES = [
  { path: "/employees", repositoryKey: "employeeRepository", resourceName: "employee" },
  { path: "/departments", repositoryKey: "departmentRepository", resourceName: "department" },
  { path: "/projects", repositoryKey: "projectRepository", resourceName: "project" },
  { path: "/kpis", repositoryKey: "kpiRepository", resourceName: "kpi" },
  { path: "/leaves", repositoryKey: "leaveRepository", resourceName: "leave" },
  { path: "/attendance", repositoryKey: "attendanceRepository", resourceName: "attendance record" },
  { path: "/payroll", repositoryKey: "payrollRepository", resourceName: "payroll record" },
];

/**
 * @param {{ verifyAccessToken?: (token: string) => Promise<object>, repositories?: object, authService?: object }} [dependencies]
 *   `repositories` lets tests inject fakes keyed the same as the container
 *   (employeeRepository, departmentRepository, ...) without a database. `authService` lets
 *   tests inject a fake/differently-backed auth service for the routes mounted below.
 */
export function createApiRouter(dependencies = {}) {
  const router = Router();

  // Health is deliberately public: it must answer before anyone can authenticate, and a
  // readiness probe has no credentials.
  router.use(healthRouter);

  // Mounted before the authentication middleware: a caller has no bearer token yet when
  // logging in, and refresh/logout authenticate via their own refresh-token cookie instead
  // of a bearer token. Resolved per-request via a getter, matching getRepository() below, so
  // importing this module never opens a pool or demands AUTH_TOKEN_SECRET.
  const getAuthService = () => dependencies.authService ?? getContainer().authService;
  router.use("/auth", createAuthRouter(getAuthService));

  // Everything mounted after this line requires a bearer token. The middleware sets
  // req.principal, resolved from the database on every request, so a deactivated account
  // is rejected immediately rather than at token expiry (decision D10).
  router.use(createAuthenticationMiddleware({
    verifyAccessToken: dependencies.verifyAccessToken ?? verifyAccessToken,
  }));

  for (const { path, repositoryKey, resourceName } of RESOURCE_ROUTES) {
    // Deferred: must not call getContainer() while building the router, only when a
    // request actually arrives, or importing this module would demand a database and
    // AUTH_TOKEN_SECRET just like verifyAccessToken above is careful to avoid.
    const getRepository = () => dependencies.repositories?.[repositoryKey] ?? getContainer()[repositoryKey];
    router.use(path, createResourceRouter(getRepository, { resourceName }));
  }

  return router;
}

export const apiRouter = createApiRouter();
