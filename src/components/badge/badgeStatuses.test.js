import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BADGE_STATUSES, BADGE_TONES, resolveBadge } from "./badgeStatuses.js";

// Every status or role string the app hands to <Badge>. Collected from the pages, the API's enums and the attendance labels.
const STATUSES_IN_USE = [
  "active", "inactive", "draft", "completed", // employees, departments, projects
  "approved", "rejected", "pending", "cancelled", "processed", // leave, payroll
  "present", "absent", "late", "leave", "On Leave", // attendance, in the form statusLabel() returns
  "superuser", "admin", "hr", "manager", "tl", "employee", // roles
];

test("every status and role the app shows resolves to a mapped tone and label, not the grey fallback", () => {
  const mapped = Object.values(BADGE_STATUSES);
  for (const status of STATUSES_IN_USE) {
    const resolved = resolveBadge(status);
    assert.ok(mapped.some((entry) => entry.tone === resolved.tone && entry.label === resolved.label), `${status} is mapped`);
    assert.ok(BADGE_TONES.includes(resolved.tone), `${status} has a tone that tokens.css defines`);
  }
});

test("labels are sentence case; the only capitals-only label is the acronym HR", () => {
  for (const { label } of Object.values(BADGE_STATUSES)) {
    if (label === "HR") continue;
    assert.notEqual(label, label.toUpperCase(), `${label} is not shouted`);
  }
});

test("'On Leave', 'on_leave', 'on-leave' and 'leave' are one status", () => {
  for (const spelling of ["On Leave", "on_leave", "on-leave", "leave", "LEAVE"]) {
    assert.equal(resolveBadge(spelling).label, "On leave");
  }
});

test("an unrecognised or empty status still renders something readable instead of nothing", () => {
  assert.deepEqual(resolveBadge("on hold"), { tone: "muted", label: "On hold" });
  assert.deepEqual(resolveBadge(undefined), { tone: "muted", label: "Unknown" });
  assert.deepEqual(resolveBadge("  "), { tone: "muted", label: "Unknown" });
});

test("Badge.css styles every tone the map can return", async () => {
  const css = await readFile(new URL("./Badge.css", import.meta.url), "utf8");
  for (const tone of BADGE_TONES.filter((t) => t !== "muted")) {
    assert.ok(css.includes(`.badge--${tone}`), `.badge--${tone} exists`);
  }
});
