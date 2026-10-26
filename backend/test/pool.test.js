import assert from "node:assert/strict";
import { test } from "node:test";
import { closePool, getPool } from "../src/db/pool.js";

test("a client dropped by the database is logged, not an uncaught exception; the pool is small and never waits forever", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none"; // never connected to: the pool is lazy
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const pool = getPool();
    assert.ok(pool.listenerCount("error") >= 1, "the pool must have an error listener");
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection due to administrator command")));
    assert.match(logged.join("\n"), /terminating connection/);
    assert.ok(pool.options.max <= 10);
    assert.ok(pool.options.connectionTimeoutMillis > 0);
  } finally {
    console.error = originalError;
    await closePool();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
