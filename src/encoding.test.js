import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// A source file saved in a legacy code page (a stray byte where an ellipsis or a dash should be) loads fine in a test
// runner that never imports it, then fails the production build. Every text file under src must be valid UTF-8.
const TEXT_FILE = /\.(jsx?|css|json|md|html)$/i;
const root = new URL("./", import.meta.url);

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => (
    entry.isDirectory() ? walk(join(dir, entry.name)) : TEXT_FILE.test(entry.name) ? [join(dir, entry.name)] : []
  )));
  return files.flat();
};

test("every source file under src is valid UTF-8", async () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bad = [];
  for (const file of await walk(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    try {
      decoder.decode(await readFile(file));
    } catch {
      bad.push(file);
    }
  }
  assert.deepEqual(bad, []);
});
