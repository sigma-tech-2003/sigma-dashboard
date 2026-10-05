import { getAuthConfig, getCompanyTimezone } from "./config/env.js";
import { getPool } from "./db/pool.js";
import { createAttendanceRepository } from "./repositories/attendanceRepository.js";
import { createDepartmentRepository } from "./repositories/departmentRepository.js";
import { createEmployeeRepository } from "./repositories/employeeRepository.js";
import { createKpiRepository } from "./repositories/kpiRepository.js";
import { createLeaveRepository } from "./repositories/leaveRepository.js";
import { createPayrollRepository } from "./repositories/payrollRepository.js";
import { createProjectRepository } from "./repositories/projectRepository.js";
import { createPasswordSetTokenRepository } from "./repositories/passwordSetTokenRepository.js";
import { createRefreshTokenRepository } from "./repositories/refreshTokenRepository.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createAttendanceMutationService } from "./services/attendanceMutationService.js";
import { createAuthService } from "./services/authService.js";
import { createDepartmentMutationService } from "./services/departmentMutationService.js";
import { createEmployeeMutationService } from "./services/employeeMutationService.js";
import { createPasswordSetService } from "./services/passwordSetService.js";
import { createPayrollMutationService } from "./services/payrollMutationService.js";

/**
 * Composition root. Built lazily on first use so that importing the app -- for tests, or
 * for `node --check` -- never opens a pool or demands AUTH_TOKEN_SECRET.
 */
let container;

export function getContainer() {
  if (!container) {
    const database = getPool();
    const authConfig = getAuthConfig();
    const userRepository = createUserRepository(database);
    const refreshTokenRepository = createRefreshTokenRepository(database);
    const employeeRepository = createEmployeeRepository(database);
    const departmentRepository = createDepartmentRepository(database);
    const attendanceRepository = createAttendanceRepository(database);
    const payrollRepository = createPayrollRepository(database);
    const passwordSetTokenRepository = createPasswordSetTokenRepository(database);
    const passwordSetService = createPasswordSetService({
      passwordSetTokenRepository,
      userRepository,
      passwordSetTokenTtlSeconds: authConfig.passwordSetTokenTtlSeconds,
    });

    container = Object.freeze({
      database,
      userRepository,
      refreshTokenRepository,
      employeeRepository,
      passwordSetTokenRepository,
      departmentRepository,
      projectRepository: createProjectRepository(database),
      kpiRepository: createKpiRepository(database),
      leaveRepository: createLeaveRepository(database),
      attendanceRepository,
      payrollRepository,
      authService: createAuthService({
        authConfig,
        userRepository,
        refreshTokenRepository,
      }),
      passwordSetService,
      employeeMutationService: createEmployeeMutationService({ employeeRepository, passwordSetService }),
      departmentMutationService: createDepartmentMutationService({ departmentRepository }),
      attendanceMutationService: createAttendanceMutationService({
        attendanceRepository,
        employeeRepository,
        timeZone: getCompanyTimezone(),
      }),
      payrollMutationService: createPayrollMutationService({ payrollRepository, employeeRepository }),
    });
  }
  return container;
}

/** Test seam: drop the memoised container so a new one is built on next use. */
export function resetContainer() {
  container = undefined;
}

/**
 * The verifier middleware/authentication.js requires. Deferred to call time so the
 * middleware can be constructed at import without a database or a signing key present.
 */
export async function verifyAccessToken(token) {
  return getContainer().authService.verifyAccessToken(token);
}
