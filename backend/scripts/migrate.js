import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrator.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

try {
  const applied = await runMigrations(getPool(), migrationsDirectory);
  console.info(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is current.");
} finally {
  await closePool();
}
