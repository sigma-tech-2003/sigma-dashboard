import pg from "pg";
import { getDatabaseConfig } from "../config/env.js";

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool(getDatabaseConfig());
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const activePool = pool;
    pool = undefined;
    await activePool.end();
  }
}
