import { Router } from "express";
import { getContainer, verifyAccessToken } from "../container.js";
import { createAuthenticationMiddleware } from "../middleware/authentication.js";
import { createAttendanceRouter } from "./attendanceRoutes.js";
import { createAuthRouter } from "./authRoutes.js";
import { createDepartmentRouter } from "./departmentRoutes.js";
import { createEmployeeRouter } from "./employeeRoutes.js";
import { healthRouter } from "./healthRoutes.js";
import { createKpiRouter } from "./kpiRoutes.js";
import { createLeaveBalanceRouter } from "./leaveBalanceRoutes.js";
import { createLeaveRouter } from "./leaveRoutes.js";
import { createPayrollRouter } from "./payrollRoutes.js";
import { createProjectRouter } from "./projectRoutes.js";
import { createResourceRouter } from "./resourceRoutes.js";

// Read routes for all seven domains. Every entry becomes a `GET /<path>` and
// `GET /<path>/:id` pair via createResourceRouter -- see
// src/controllers/resourceController.js for why one factory serves all seven rather than
// seven near-identical files. Writes land per domain as each phase reaches it; employees',
// departments', attendance's, payroll's, projects', KPIs' and leaves' POST/PATCH/DELETE (and the KPI rating
// POST) are mounted separately below, at the same paths -- Express dispatches by method as well as
// path, so the two coexist.
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
 * @param {{ verifyAccessToken?: (token: string) => Promise<object>, repositories?: object, authService?: object, employeeMutationService?: object, departmentMutationService?: object, attendanceMutationService?: object, payrollMutationService?: object, projectMutationService?: object, kpiMutationService?: object, leaveMutationService?: object, leaveBalanceService?: object, passwordSetService?: object }} [dependencies]
 *   `repositories` lets tests inject fakes keyed the same as the container
 *   (employeeRepository, departmentRepository, ...) without a database. `authService`,
 *   `employeeMutationService`, `departmentMutationService`, `attendanceMutationService`,
 *   `payrollMutationService`, `projectMutationService`, `kpiMutationService`,
 *   `leaveMutationService`, `leaveBalanceService` and `passwordSetService` let tests inject
 *   fake/differently-backed services for the routes mounted below.
 */
export function createApiRouter(dependencies = {}) {
  const router = Router();

  // Health is deliberately public: it must answer before anyone can authenticate, and a
  // readiness probe has no credentials.
  router.use(healthRouter);

  // Mounted before the authentication middleware: a caller has no bearer token yet when
  // logging in, and refresh/logout/set-password authenticate via their own token/cookie
  // instead of a bearer token. Resolved per-request via a getter, matching getRepository()
  // below, so importing this module never opens a pool or demands AUTH_TOKEN_SECRET.
  const getAuthService = () => dependencies.authService ?? getContainer().authService;
  const getPasswordSetService = () => dependencies.passwordSetService ?? getContainer().passwordSetService;
  router.use("/auth", createAuthRouter({ getAuthService, getPasswordSetService }));

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

  const getEmployeeMutationService = () => dependencies.employeeMutationService ?? getContainer().employeeMutationService;
  router.use("/employees", createEmployeeRouter(getEmployeeMutationService));

  const getDepartmentMutationService = () => dependencies.departmentMutationService ?? getContainer().departmentMutationService;
  router.use("/departments", createDepartmentRouter(getDepartmentMutationService));

  const getAttendanceMutationService = () => dependencies.attendanceMutationService ?? getContainer().attendanceMutationService;
  router.use("/attendance", createAttendanceRouter(getAttendanceMutationService));

  const getPayrollMutationService = () => dependencies.payrollMutationService ?? getContainer().payrollMutationService;
  router.use("/payroll", createPayrollRouter(getPayrollMutationService));

  const getProjectMutationService = () => dependencies.projectMutationService ?? getContainer().projectMutationService;
  router.use("/projects", createProjectRouter(getProjectMutationService));

  const getKpiMutationService = () => dependencies.kpiMutationService ?? getContainer().kpiMutationService;
  router.use("/kpis", createKpiRouter(getKpiMutationService));

  const getLeaveMutationService = () => dependencies.leaveMutationService ?? getContainer().leaveMutationService;
  router.use("/leaves", createLeaveRouter(getLeaveMutationService));

  // Its own path: GET /leaves/:id is the read router's, so /leaves/balance would be a malformed id.
  const getLeaveBalanceService = () => dependencies.leaveBalanceService ?? getContainer().leaveBalanceService;
  router.use("/leave-balances", createLeaveBalanceRouter(getLeaveBalanceService));

  return router;
}

export const apiRouter = createApiRouter();
