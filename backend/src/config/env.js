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
