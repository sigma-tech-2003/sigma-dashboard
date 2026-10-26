import pg from "pg";
import { getDatabaseConfig } from "../config/env.js";

const { Pool } = pg;
let pool;

// A hosted database (Neon's free tier suspends its compute after a few idle minutes) closes idle connections from
// its side. pg then emits 'error' on the pool; with no listener that is an uncaught exception and the whole API
// process dies. The broken client has already been removed from the pool, so the next query just opens a new one.
const POOL_OPTIONS = Object.freeze({
  max: 5, // small on purpose: free hosted databases allow few connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000, // a database waking from suspend answers in seconds; never wait forever
  keepAlive: true,
});

export function getPool() {
  if (!pool) {
    pool = new Pool({ ...getDatabaseConfig(), ...POOL_OPTIONS });
    pool.on("error", (error) => {
      console.error(`Idle PostgreSQL client dropped: ${error.message}`);
    });
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
