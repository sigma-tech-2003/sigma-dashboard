/* global require */
"use strict";

const { EventEmitter } = require("node:events");
const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyAuthSession } = require("./index");

const PRODUCTION_ORIGIN = "https://sigma-dashboard-theta.vercel.app";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.body = undefined;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  send(body) {
    this.body = body;
    this.emit("finish");
    return this;
  }

  end(body) {
    this.body = body;
    this.emit("finish");
    return this;
  }
}

function request({ method, origin, requestedHeaders = "", body }) {
  const headers = {
    origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": requestedHeaders,
  };

  return {
    method,
    body,
    headers,
    header(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

async function invoke(options) {
  const response = new MockResponse();
  await verifyAuthSession(request(options), response);
  return response;
}

test("verifyAuthSession accepts only the production origin during callable preflight", async () => {
  const response = await invoke({
    method: "OPTIONS",
    origin: PRODUCTION_ORIGIN,
    requestedHeaders: "authorization,content-type",
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.getHeader("access-control-allow-origin"), PRODUCTION_ORIGIN);
  assert.equal(response.getHeader("access-control-allow-methods"), "POST");
  assert.equal(
    response.getHeader("access-control-allow-headers"),
    "authorization,content-type",
  );
});

test("verifyAuthSession never grants an unknown origin a matching CORS response", async () => {
  const response = await invoke({
    method: "OPTIONS",
    origin: "https://untrusted.example",
    requestedHeaders: "authorization,content-type",
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.getHeader("access-control-allow-origin"), PRODUCTION_ORIGIN);
  assert.notEqual(response.getHeader("access-control-allow-origin"), "https://untrusted.example");
});

test("verifyAuthSession rejects invalid methods while retaining CORS headers for its origin", async () => {
  const response = await invoke({
    method: "GET",
    origin: PRODUCTION_ORIGIN,
    body: { data: { selectedRole: "employee" } },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.getHeader("access-control-allow-origin"), PRODUCTION_ORIGIN);
  assert.equal(response.body?.error?.status, "INVALID_ARGUMENT");
});
