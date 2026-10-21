import assert from "node:assert/strict";
import test from "node:test";
import { employeeCreateSchema, employeeUpdateSchema } from "../src/validation/employeeSchemas.js";
import {
  PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, changePasswordSchema, passwordSchema, resetPasswordSchema,
} from "../src/validation/passwordSchemas.js";

// D41: one rule for every password the API accepts, so the creator's temporary password, an admin's reset and the
// employee's own new password cannot disagree about what is allowed.

const CREATE = Object.freeze({
  email: "a@example.com", role: "employee", full_name: "A B", position_title: "Dev", joined_on: "2026-01-01",
  basic: 1, allowances: 0, temporary_password: "temp-pass-1234",
});

test("the limits are 8 and 200, inclusive", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(PASSWORD_MAX_LENGTH, 200);
  assert.equal(passwordSchema.safeParse("12345678").success, true);
  assert.equal(passwordSchema.safeParse("x".repeat(200)).success, true);
  assert.equal(passwordSchema.safeParse("1234567").success, false);
  assert.equal(passwordSchema.safeParse("x".repeat(201)).success, false);
});

test("a password is whatever was typed: spaces count and nothing is trimmed", () => {
  assert.equal(passwordSchema.safeParse("        ").success, true, "eight spaces is eight characters");
  const parsed = passwordSchema.safeParse("  padded  ");
  assert.equal(parsed.data, "  padded  ");
});

test("only strings are passwords", () => {
  for (const value of [12345678, null, undefined, {}, [], true]) {
    assert.equal(passwordSchema.safeParse(value).success, false, String(value));
  }
});

test("creating an employee REQUIRES temporary_password, and rejects a bad one", () => {
  assert.equal(employeeCreateSchema.safeParse(CREATE).success, true);
  const { temporary_password, ...without } = CREATE;
  void temporary_password;
  assert.equal(employeeCreateSchema.safeParse(without).success, false);
  assert.equal(employeeCreateSchema.safeParse({ ...CREATE, temporary_password: "short" }).success, false);
});

test("an unknown password-ish field is still refused by the strict create schema", () => {
  for (const key of ["password", "password_hash", "must_change_password", "password_set_by_employee_id"]) {
    assert.equal(employeeCreateSchema.safeParse({ ...CREATE, [key]: "x" }).success, false, key);
  }
});

test("an UPDATE can never set a password: neither the temporary one nor any password field is accepted", () => {
  for (const key of ["temporary_password", "password", "password_hash", "must_change_password"]) {
    assert.equal(employeeUpdateSchema.safeParse({ [key]: "whatever-123" }).success, false, key);
  }
});

test("change-password: both fields are required; the new one follows the rule; the current only has to be present", () => {
  assert.equal(changePasswordSchema.safeParse({ current_password: "x", new_password: "12345678" }).success, true);
  assert.equal(changePasswordSchema.safeParse({ current_password: "x" }).success, false);
  assert.equal(changePasswordSchema.safeParse({ new_password: "12345678" }).success, false);
  assert.equal(changePasswordSchema.safeParse({ current_password: "", new_password: "12345678" }).success, false);
  assert.equal(changePasswordSchema.safeParse({ current_password: "x", new_password: "short" }).success, false);
});

test("change-password is strict: an extra key is refused", () => {
  assert.equal(changePasswordSchema.safeParse({ current_password: "x", new_password: "12345678", user_id: "other" }).success, false);
});

test("reset: temporary_password only, following the rule, strict", () => {
  assert.equal(resetPasswordSchema.safeParse({ temporary_password: "12345678" }).success, true);
  assert.equal(resetPasswordSchema.safeParse({}).success, false);
  assert.equal(resetPasswordSchema.safeParse({ temporary_password: "short" }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ temporary_password: "12345678", role: "admin" }).success, false);
});

test("a rejected password is not echoed in the validation issues", () => {
  const result = changePasswordSchema.safeParse({ current_password: "my-secret-current", new_password: "short" });

  assert.equal(JSON.stringify(result.error.issues).includes("short\""), false);
  assert.equal(JSON.stringify(result.error.issues).includes("my-secret-current"), false);
});
