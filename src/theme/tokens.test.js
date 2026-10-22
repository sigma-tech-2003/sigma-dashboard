import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { T, alpha, setThemePalette } from "./theme.js";

// The palette lives in tokens.css only. These tests read that file, so a colour change that breaks readability fails here
// instead of in someone's eyes: every text pair is at least 4.5:1 (WCAG AA) and every form-control border at least 3:1.

const css = await readFile(new URL("./tokens.css", import.meta.url), "utf8");

const block = (selector) => {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, `tokens.css has ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
};
const declarations = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const dark = declarations(block(":root"));
const light = { ...dark, ...declarations(block(':root[data-theme="light"]')) };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (theme, name) => {
  const value = theme[name];
  assert.match(value ?? "", /^#[0-9a-f]{6}$/i, `--${name} is a plain hex colour (got ${value})`);
  return value;
};
const toHex = (channels) => "#" + channels.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const over = (fg, bg, percent) => toHex(rgb(fg).map((v, i) => v * (percent / 100) + rgb(bg)[i] * (1 - percent / 100)));
const tintPercent = (theme, name) => Number(/ (\d+)%/.exec(theme[name])?.[1]);

const themes = { dark, light };

for (const [name, theme] of Object.entries(themes)) {
  test(`${name}: every text colour reads at 4.5:1 or better on every surface it is used on`, () => {
    for (const surface of ["bg", "card", "raised", "surface", "sidebar"]) {
      for (const text of ["text", "muted-light", "muted", "primary-text", "success", "warning", "danger", "secondary", "purple"]) {
        const r = ratio(hex(theme, `color-${text}`), hex(theme, `color-${surface}`));
        assert.ok(r >= 4.5, `${name}: ${text} on ${surface} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`${name}: text on a solid button fill reads at 4.5:1 or better`, () => {
    for (const [fill, on] of [["primary", null], ["success-fill", "on-success"], ["warning-fill", "on-warning"], ["danger-fill", "on-danger"]]) {
      const text = on ? hex(theme, `color-${on}`) : hex(theme, "color-white");
      const r = ratio(text, hex(theme, `color-${fill}`));
      assert.ok(r >= 4.5, `${name}: text on ${fill} is ${r.toFixed(2)}:1`);
    }
    assert.ok(ratio(hex(theme, "color-white"), hex(theme, "color-primary-hover")) >= 4.5, `${name}: white on primary-hover`);
  });

  test(`${name}: a status pill (its colour on a tint of itself over a card) reads at 4.5:1 or better`, () => {
    for (const status of ["success", "warning", "danger"]) {
      const tint = over(hex(theme, `color-${status}`), hex(theme, "color-card"), tintPercent(theme, `color-${status}-glow`));
      const r = ratio(hex(theme, `color-${status}`), tint);
      assert.ok(r >= 4.5, `${name}: ${status} pill is ${r.toFixed(2)}:1`);
    }
  });

  test(`${name}: every badge tone (text on a tint of itself over a card) reads at 4.5:1 or better`, () => {
    const pills = [["primary-text", "primary-tint"], ["secondary", "secondary-glow"], ["purple", "purple-glow"], ["muted-light", "muted-glow"]];
    for (const [text, tint] of pills) {
      const base = text === "muted-light" ? "muted" : text === "primary-text" ? "primary" : text;
      const background = over(hex(theme, `color-${base}`), hex(theme, "color-card"), tintPercent(theme, `color-${tint}`));
      const r = ratio(hex(theme, `color-${text}`), background);
      assert.ok(r >= 4.5, `${name}: ${text} on ${tint} is ${r.toFixed(2)}:1`);
    }
  });

  test(`${name}: form-control borders meet the 3:1 non-text contrast against the card and the page`, () => {
    for (const surface of ["card", "bg", "raised"]) {
      const r = ratio(hex(theme, "color-border-control"), hex(theme, `color-${surface}`));
      assert.ok(r >= 3, `${name}: control border on ${surface} is ${r.toFixed(2)}:1`);
    }
  });
}

test("text hierarchy is real: in both themes text, secondary and tertiary are three distinct, ordered strengths", () => {
  for (const [name, theme] of Object.entries(themes)) {
    const on = hex(theme, "color-card");
    const [t1, t2, t3] = ["text", "muted-light", "muted"].map((n) => ratio(hex(theme, `color-${n}`), on));
    assert.ok(t1 > t2 && t2 > t3, `${name}: ${t1.toFixed(1)} > ${t2.toFixed(1)} > ${t3.toFixed(1)}`);
  }
});

test("the dark and light themes define the same set of tokens (no token exists in only one)", () => {
  const lightOnly = Object.keys(declarations(block(':root[data-theme="light"]'))).filter((n) => !(n in dark));
  assert.deepEqual(lightOnly, [], "light overrides only tokens that exist in the default block");
});

test("type and spacing follow the scale: 12px floor, 14px body, 4px grid, weights capped at 600", () => {
  assert.equal(dark["font-size-xs"], "12px");
  assert.equal(dark["font-size-md"], "14px");
  assert.equal(dark["font-weight-extrabold"], "600");
  for (const step of ["space-1", "space-2", "space-4", "space-6", "space-9", "space-10", "space-11"]) {
    assert.equal(parseInt(dark[step], 10) % 4, 0, `${step} (${dark[step]}) sits on the 4px grid`);
  }
  for (const size of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl"]) {
    assert.ok(parseInt(dark[`font-size-${size}`], 10) >= 12, `font-size-${size} is not below 12px`);
  }
});

// ---- theme.js is only a reader of tokens.css ----

test("every colour in T is a var() reference to a token that exists in tokens.css", () => {
  for (const [key, value] of Object.entries(T)) {
    const match = /^var\(--(color-[a-z-]+)\)$/.exec(value);
    assert.ok(match, `T.${key} is a var() reference (got ${value})`);
    assert.ok(match[1] in dark, `T.${key} -> --${match[1]} is defined in tokens.css`);
  }
});

test("T holds no hex colour at all, so there is no second palette to drift", () => {
  assert.equal(Object.values(T).some((value) => /#[0-9a-f]{3,8}/i.test(value)), false);
});

test("alpha() builds a colour-mix, which works on a variable (appending hex digits does not)", () => {
  assert.equal(alpha(T.primary, 20), "color-mix(in srgb, var(--color-primary) 20%, transparent)");
  assert.equal(alpha("#ff0000", 50), "color-mix(in srgb, #ff0000 50%, transparent)");
});

test("setThemePalette is kept for old callers and just returns T", () => {
  assert.equal(setThemePalette("light"), T);
  assert.equal(setThemePalette(), T);
});
