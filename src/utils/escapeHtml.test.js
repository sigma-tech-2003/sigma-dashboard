import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "./escapeHtml.js";

test("markup in a value prints as text, so an employee name cannot run script in the payslip window", () => {
  assert.equal(escapeHtml("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(escapeHtml(`"><script>x()</script>`), "&quot;&gt;&lt;script&gt;x()&lt;/script&gt;");
});

test("ampersands are escaped first, so an escaped value is not double-decoded", () => {
  assert.equal(escapeHtml("R&D <team>"), "R&amp;D &lt;team&gt;");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

test("quotes are escaped for use inside attributes, and ordinary text is left alone", () => {
  assert.equal(escapeHtml(`O'Brien "Ops"`), "O&#39;Brien &quot;Ops&quot;");
  assert.equal(escapeHtml("Sara Ali"), "Sara Ali");
});

test("null, undefined and numbers become text rather than throwing", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(2027), "2027");
});
