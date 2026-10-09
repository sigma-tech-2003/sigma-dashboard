import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { session } from "../auth/session.js";
import { failure, installFakeFetch, noContent, ok } from "../test-support/fakes.js";
import { signIn, signOutUser } from "./authService.js";
import { AuthSessionError, verifyAuthSession } from "./authSessionService.js";

// LoginPage calls these in this order, unchanged from the Firebase version:
//   signIn(email, pass)  ->  verifyAuthSession(selectedRole)  ->  (on failure) signOutUser()
// and the app reads who is signed in from the shared session. These tests run that exact sequence.

const PRINCIPAL = { userId: "u1", employeeId: "e1", role: "manager", departmentId: "d1", isTeamLead: false };
const PROFILE = {
  id: "e1", employee_number: "EMP-1", full_name: "Aisha Khan", email: "aisha@b.co", phone: null, role: "manager",
  department_id: "d1", department_name: "Engineering", position_title: "Lead", joined_on: "2024-03-15", team_lead_id: null, employment_status: "active",
};

const handler = (overrides = {}) => (call) => {
  if (overrides[call.path]) return overrides[call.path](call);
  if (call.path === "/auth/login") return ok({ accessToken: "T1", expiresIn: 900, principal: PRINCIPAL });
  if (call.path === "/auth/me") return ok(PROFILE);
  if (call.path === "/auth/logout") return noContent();
  return failure(404, "not_found");
};

let fake;
afterEach(async () => {
  fake?.restore();
  fake = installFakeFetch(handler());
  await signOutUser();
  fake.restore();
  fake = null;
});

test("signIn resolves { user } and does NOT yet publish a session user (nothing renders before the role check)", async () => {
  fake = installFakeFetch(handler());
  const credential = await signIn("aisha@b.co", "pw");

  assert.equal(credential.user.role, "manager");
  assert.equal(session.getState().user, null);
});

test("verifyAuthSession with the right role resolves { employee, linkage } and publishes the user", async () => {
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");
  const principal = await verifyAuthSession("manager");

  assert.equal(principal.linkage, "uid");
  assert.equal(principal.employee.id, "e1");
  assert.equal(principal.employee.dept, "Engineering");
  assert.deepEqual(Object.keys(principal.employee).sort(), ["dept", "email", "empId", "id", "joinDate", "name", "phone", "pos", "role"]);
  assert.equal(session.getState().user.id, "e1");
});

test("WRONG PERSONA: verifyAuthSession throws the existing message, the user is never published, and the session is revoked", async () => {
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");

  await assert.rejects(verifyAuthSession("admin"), (error) => {
    assert.ok(error instanceof AuthSessionError, "LoginPage's instanceof check passes");
    assert.equal(error.code, "permission-denied");
    assert.equal(error.message, "These credentials do not belong to the selected role.");
    return true;
  });

  assert.equal(session.getState().user, null, "the app never renders for the wrong persona");
  assert.ok(fake.calls.some((c) => c.path === "/auth/logout"), "the server session was revoked");
  assert.ok(!fake.calls.some((c) => c.path === "/auth/me"), "the profile was never loaded");
});

test("LoginPage's catch path: signOutUser after a failed verify does not throw", async () => {
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");
  await verifyAuthSession("admin").catch(() => {});

  await signOutUser();
});

test("bad credentials: signIn rejects with an AuthSessionError carrying the generic sign-in message", async () => {
  fake = installFakeFetch(handler({ "/auth/login": () => failure(401, "unauthenticated") }));

  await assert.rejects(signIn("aisha@b.co", "bad"), (error) => {
    assert.ok(error instanceof AuthSessionError);
    assert.equal(error.message, "Unable to sign in. Check your credentials and try again.");
    return true;
  });
});

test("a server outage at sign-in shows the 'temporarily unavailable' message, not 'check your credentials'", async () => {
  fake = installFakeFetch(handler({ "/auth/login": () => failure(503, "unavailable") }));

  await assert.rejects(signIn("aisha@b.co", "pw"), (error) => error instanceof AuthSessionError && error.code === "unavailable");
});

test("verifyAuthSession with no role compares nothing (a session restored on reload, D37)", async () => {
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");

  assert.equal((await verifyAuthSession(null)).employee.role, "manager");
});

test("the messages LoginPage reads are the ones it read under Firebase", () => {
  assert.equal(new AuthSessionError("invalid-argument").message, "Select a valid role before signing in.");
  assert.equal(new AuthSessionError("permission-denied").message, "These credentials do not belong to the selected role.");
  assert.equal(new AuthSessionError("data-integrity").message, "Employee account data could not be verified. Contact an administrator.");
  assert.equal(new AuthSessionError("whatever").code, "internal");
});

test("signOutUser clears the published user and swallows a failing logout call", async () => {
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");
  await verifyAuthSession("manager");
  fake.restore();
  fake = installFakeFetch(handler({ "/auth/logout": () => failure(500, "internal") }));

  await signOutUser();

  assert.equal(session.getState().user, null);
});

test("signing out empties the department directory (it belongs to the person who learnt it)", async () => {
  const { departmentDirectory } = await import("./departmentDirectory.js");
  fake = installFakeFetch(handler());
  await signIn("aisha@b.co", "pw");
  await verifyAuthSession("manager");
  departmentDirectory.learn([{ id: "d1", name: "Engineering" }]);

  await signOutUser();

  assert.deepEqual(departmentDirectory.lookup(), []);
});
