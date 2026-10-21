import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canResetPassword } from "./passwordReset.js";

const ROLES = ["admin", "hr", "manager", "tl", "employee"];
const user = (role, id = "me") => ({ id, role });
const target = (role, id = "them") => ({ id, role });

test("admin may reset anyone but themselves", () => {
  for (const role of ROLES) assert.equal(canResetPassword(user("admin"), target(role)), true, role);
  assert.equal(canResetPassword(user("admin", "a1"), target("admin", "a1")), false);
});

test("hr may reset manager, tl and employee, and NEVER an admin or another hr", () => {
  for (const role of ["manager", "tl", "employee"]) assert.equal(canResetPassword(user("hr"), target(role)), true, role);
  for (const role of ["admin", "hr"]) assert.equal(canResetPassword(user("hr"), target(role)), false, role);
});

test("manager, tl and employee are never offered a reset, not even for their own reports", () => {
  for (const role of ["manager", "tl", "employee"]) {
    for (const targetRole of ROLES) assert.equal(canResetPassword(user(role), target(targetRole)), false, `${role} -> ${targetRole}`);
  }
});

test("nobody resets their own password here (they change it), whatever their role", () => {
  for (const role of ROLES) assert.equal(canResetPassword(user(role, "x"), target(role, "x")), false, role);
});

test("an unknown role or a missing user or employee is no reset", () => {
  assert.equal(canResetPassword(user("owner"), target("employee")), false);
  assert.equal(canResetPassword(null, target("employee")), false);
  assert.equal(canResetPassword(user("admin"), null), false);
  assert.equal(canResetPassword(user("admin"), target("superuser")), false);
});

test("the table is the backend's ROLE_ASSIGNMENTS for the two roles that may reset", async () => {
  const source = await readFile(new URL("../../backend/src/services/employeeAuthorizationService.js", import.meta.url), "utf8");
  const block = /const ROLE_ASSIGNMENTS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? "";
  const parse = (role) => [...(new RegExp(`${role}: new Set\\(\\[([^\\]]*)\\]\\)`).exec(block)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();

  for (const role of ["admin", "hr"]) {
    const allowed = ROLES.filter((targetRole) => canResetPassword(user(role), target(targetRole))).sort();
    assert.ok(parse(role).length > 0, `found ${role} in the backend table`);
    assert.deepEqual(allowed, parse(role), role);
  }
});
