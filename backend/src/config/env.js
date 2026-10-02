import "dotenv/config";

const DEFAULT_PORT = 4000;

const readString = (value) => (typeof value === "string" ? value.trim() : "");

const parsePort = (value) => {
  const port = Number.parseInt(readString(value), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
};

const parseBoolean = (value) => ["true", "1", "require"].includes(
  readString(value).toLowerCase(),
);

const parseOrigins = (value) => Object.freeze(
  readString(value)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export const environment = Object.freeze({
  nodeEnv: readString(process.env.NODE_ENV) || "development",
  port: parsePort(process.env.PORT),
  corsAllowedOrigins: parseOrigins(process.env.CORS_ALLOWED_ORIGINS),
  authTokenIssuer: readString(process.env.AUTH_TOKEN_ISSUER),
  authTokenAudience: readString(process.env.AUTH_TOKEN_AUDIENCE),
});

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
// 24 hours: long enough for an admin/hr to relay the token to the employee out of band
// (there is no email sending in this system -- see docs/schema-design.md's decision entry),
// short enough that a token sitting in a chat message or printed sheet isn't a standing risk.
const DEFAULT_PASSWORD_SET_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MINIMUM_SECRET_LENGTH = 32;

const parseSeconds = (value, fallback) => {
  const seconds = Number.parseInt(readString(value), 10);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : fallback;
};

/**
 * Read like getDatabaseConfig: a function rather than a frozen export, so importing this
 * module never throws. Tests and the syntax check can load the app without a signing key.
 *
 * The access token TTL is deliberately short. Under decision D10 a revoked account is
 * rejected by the per-request principal query, not by token expiry, so a long TTL would
 * only widen the window in which a stolen token is replayable.
 */
export function getAuthConfig() {
  const secret = readString(process.env.AUTH_TOKEN_SECRET);
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `AUTH_TOKEN_SECRET must be set to at least ${MINIMUM_SECRET_LENGTH} characters before issuing tokens.`,
    );
  }

  return Object.freeze({
    secret,
    issuer: environment.authTokenIssuer || "sigma-hrm-api",
    audience: environment.authTokenAudience || "sigma-hrm-web",
    accessTokenTtlSeconds: parseSeconds(
      process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    ),
    refreshTokenTtlSeconds: parseSeconds(
      process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    ),
    passwordSetTokenTtlSeconds: parseSeconds(
      process.env.PASSWORD_SET_TOKEN_TTL_SECONDS,
      DEFAULT_PASSWORD_SET_TOKEN_TTL_SECONDS,
    ),
  });
}

/**
 * The IANA timezone that defines "today" for attendance (D27). Required, with no default: a
 * missing or misspelled value must fail loudly rather than silently fall back to a zone that
 * would wrongly accept or reject a day's attendance. server.js calls this before listening,
 * so a bad value stops the process at boot instead of failing the first request.
 *
 * A function, like getAuthConfig, so importing this module never throws.
 */
export function getCompanyTimezone() {
  const timeZone = readString(process.env.COMPANY_TIMEZONE);
  if (!timeZone) {
    throw new Error("COMPANY_TIMEZONE must be set to an IANA timezone name, e.g. Asia/Karachi.");
  }

  // Intl also accepts UTC-offset forms like "+05:00", which are not IANA names and carry no
  // daylight-saving rules; reject them explicitly.
  let valid = !/^[+-]/.test(timeZone);
  if (valid) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new Error(`COMPANY_TIMEZONE "${timeZone}" is not a valid IANA timezone name, e.g. Asia/Karachi.`);
  }

  return timeZone;
}

export function getDatabaseConfig() {
  const connectionString = readString(process.env.DATABASE_URL);
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set before connecting to PostgreSQL.");
  }

  return Object.freeze({
    connectionString,
    ssl: parseBoolean(process.env.DATABASE_SSL)
      ? { rejectUnauthorized: true }
      : false,
  });
}
