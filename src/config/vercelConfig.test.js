import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API_BASE_URL } from "./api.js";

const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));

test("D36: /api/* is rewritten to an HTTPS API host with the request path preserved", () => {
  const rewrite = config.rewrites.find((entry) => entry.source === "/api/:path*");
  assert.ok(rewrite, "an /api/:path* rewrite exists");
  const destination = new URL(rewrite.destination.replace(":path*", "x"));
  assert.equal(destination.protocol, "https:");
  // The refresh cookie is scoped to Path=/api/v1/auth, so the path must reach the API unchanged.
  assert.ok(rewrite.destination.endsWith("/api/:path*"), "the destination keeps the /api prefix");
});

test("the base URL the app calls is covered by that rewrite", () => {
  assert.ok(API_BASE_URL.startsWith("/api/"));
});

test("no rewrite shadows the app itself (a catch-all would send pages to the API)", () => {
  for (const entry of config.rewrites) assert.ok(entry.source.startsWith("/api/"), entry.source);
});

test("API responses are never cached by Vercel's CDN", () => {
  const rule = config.headers.find((entry) => entry.source === "/api/:path*");
  assert.ok(rule.headers.some((header) => header.key === "x-vercel-enable-rewrite-caching" && header.value === "0"));
});
