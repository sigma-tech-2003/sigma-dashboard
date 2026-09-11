import { getAuthConfig } from "./config/env.js";
import { getPool } from "./db/pool.js";
import { createEmployeeRepository } from "./repositories/employeeRepository.js";
import { createRefreshTokenRepository } from "./repositories/refreshTokenRepository.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createAuthService } from "./services/authService.js";

/**
 * Composition root. Built lazily on first use so that importing the app -- for tests, or
 * for `node --check` -- never opens a pool or demands AUTH_TOKEN_SECRET.
 */
let container;

export function getContainer() {
  if (!container) {
    const database = getPool();
    const userRepository = createUserRepository(database);
    const refreshTokenRepository = createRefreshTokenRepository(database);

    container = Object.freeze({
      database,
      userRepository,
      refreshTokenRepository,
      employeeRepository: createEmployeeRepository(database),
      authService: createAuthService({
        authConfig: getAuthConfig(),
        userRepository,
        refreshTokenRepository,
      }),
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
