import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AGENTS.md section 5, enforced: GSAP is set up in useLayoutEffect inside gsap.context() and reverted on unmount, only
// transform and opacity (and SVG stroke) move, nothing hard-codes a colour, ScrollTrigger scrolls `.content`, and every
// animation hook respects prefers-reduced-motion. These read the source, so a change that breaks a rule fails here.

const srcDir = fileURLToPath(new URL("../../", import.meta.url));
const motionDir = fileURLToPath(new URL("./", import.meta.url));

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  )));
  return nested.flat();
};

const sources = async () => {
  const files = (await walk(srcDir)).filter((file) => /\.jsx?$/.test(file) && !/\.test\.js$/.test(file));
  return Promise.all(files.map(async (file) => ({ file: relative(srcDir, file).replaceAll("\\", "/"), text: await readFile(file, "utf8") })));
};

// The text of every gsap.to/from/fromTo/set call, by matching parentheses from the opening one.
const gsapCalls = (text) => {
  const calls = [];
  const pattern = /\bgsap\.(to|from|fromTo|set)\(/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (depth > 0 && index < text.length) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") depth -= 1;
      index += 1;
    }
    calls.push(text.slice(match.index, index));
  }
  return calls;
};

test("only useGsap.js imports the gsap package, so every animation goes through the one context", async () => {
  const importing = (await sources())
    .filter(({ text }) => /from\s+["']gsap(\/[^"']*)?["']/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(importing, ["hooks/motion/useGsap.js"]);
});

test("useGsap sets up in useLayoutEffect with gsap.context and reverts it on unmount, never in useEffect", async () => {
  const text = await readFile(join(motionDir, "useGsap.js"), "utf8");
  assert.match(text, /useLayoutEffect\(/);
  assert.match(text, /gsap\.context\(/);
  assert.match(text, /\.revert\(\)/);
  assert.doesNotMatch(text, /\buseEffect\(/);
});

test("no file that animates with GSAP sets it up inside a useEffect", async () => {
  const offenders = (await sources())
    .filter(({ file, text }) => file !== "hooks/motion/useGsap.js" && /\bgsap\./.test(text) && /\buseEffect\(/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("animations move only opacity, transforms and SVG strokes: never width, height, top, left, margin or padding", async () => {
  const layoutKey = /\b(width|height|top|left|right|bottom|margin\w*|padding\w*|fontSize|borderRadius|lineHeight)\s*:/;
  const offenders = [];
  for (const { file, text } of await sources()) {
    for (const call of gsapCalls(text)) {
      if (layoutKey.test(call)) offenders.push(`${file}: ${call.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("animation code and the motion tokens contain no hard-coded colour", async () => {
  const hex = /#[0-9a-fA-F]{3,8}\b/;
  const offenders = [];
  for (const { file, text } of await sources()) {
    if (file === "theme/motion.js" || file.startsWith("hooks/motion/")) {
      if (hex.test(text)) offenders.push(file);
      continue;
    }
    for (const call of gsapCalls(text)) if (hex.test(call)) offenders.push(`${file}: ${call.slice(0, 60)}`);
  }
  assert.deepEqual(offenders, []);
});

test("every ScrollTrigger scrolls the .content container (found with closest, as a selector would miss it inside a context), and fires once", async () => {
  const offenders = [];
  for (const { file, text } of await sources()) {
    if (!/scrollTrigger\s*:|ScrollTrigger\.create\(/.test(text)) continue;
    const scrollsContent = /scroller:\s*scroller\b/.test(text) && /closest\(["']\.content["']\)/.test(text);
    if (!scrollsContent || !/once:\s*true/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("page motion is capped: a few entrance targets and a few ScrollTriggers per page", async () => {
  const { MAX_ENTRANCE_TARGETS, MAX_SCROLL_REVEALS } = await import("../../theme/motion.js");
  assert.ok(MAX_ENTRANCE_TARGETS <= 16);
  assert.ok(MAX_SCROLL_REVEALS <= 6);
});

test("every animation hook honours prefers-reduced-motion", async () => {
  const hooks = (await sources()).filter(({ file }) => file.startsWith("hooks/motion/") && !["useGsap.js"].some((name) => file.endsWith(name)));
  assert.ok(hooks.length >= 5, "the animation hooks are where this expects them");
  for (const { file, text } of hooks) {
    assert.ok(/\breduced\b|prefers-reduced-motion|prefersReducedMotion/.test(text), `${file} checks for reduced motion`);
  }
});

test("the motion tokens hold numbers and ease names only", async () => {
  const text = await readFile(fileURLToPath(new URL("../../theme/motion.js", import.meta.url)), "utf8");
  assert.doesNotMatch(text, /rgb|hsl|var\(--color/);
});
