import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { promptHidden } from "../scripts/bootstrap-admin.js";

// promptHidden is imported directly, not invoked as a script -- the invokedDirectly guard in
// bootstrap-admin.js keeps the CLI body (which calls getPool()) from running on import.

/** A stdin stand-in: a plain EventEmitter with the handful of members promptHidden touches. */
function fakeStdin() {
  const emitter = new EventEmitter();
  emitter.isTTY = false; // skips the setRawMode branch entirely, matching a piped/test stream
  emitter.resume = () => {};
  emitter.pause = () => {};
  emitter.setEncoding = () => {};
  return emitter;
}

function fakeStdout() {
  const written = [];
  return { write: (text) => written.push(text), written };
}

test("a pasted chunk resolves to exactly the text before the carriage return", async () => {
  // The literal case from the chunk-as-single-character bug: a whole pasted value plus its
  // trailing \r arrives as one chunk, not one character at a time.
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("secret\r"));
  assert.equal(await promise, "secret");
});

test("a backspace inside a chunk deletes exactly one character", async () => {
  // The literal case from the broken Backspace branch: DEL (\x7f) arrives mid-chunk, not as
  // its own event.
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("abc\x7f\n"));
  assert.equal(await promise, "ab");
});

test("Ctrl+C rejects rather than resolving", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("ab\x03"));
  await assert.rejects(promise, /Aborted/);
});

test("input accumulates correctly across multiple data events", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("sec"));
  stdin.emit("data", Buffer.from("ret\n"));
  assert.equal(await promise, "secret");
});

test("EOF (Ctrl+D) resolves the same as Enter", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("secret\x04"));
  assert.equal(await promise, "secret");
});

test("backspace on empty input is a no-op, not a crash", async () => {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const promise = promptHidden("Password: ", { stdin, stdout });
  stdin.emit("data", Buffer.from("\x7fab\n"));
  assert.equal(await promise, "ab");
});
