import assert from "node:assert/strict";
import test from "node:test";
import { fromApi as leaveBalanceFromApi } from "../services/mappers/leaveBalance.js";
import { totalTakenLabel, totalTakenSub, usageCards } from "./leaveUsage.js";

const EMP = "11111111-1111-4111-8111-111111111111";
const RESPONSE = {
  employee_id: EMP, as_of: "2026-10-09", year: 2026,
  taken: { Annual: 3, Sick: 2, Casual: 0, Maternity: 0, Emergency: 1 }, total: 6,
};

// What the page actually receives: the mapper's one-entry map, indexed by the employee's id.
const balanceFor = (response) => leaveBalanceFromApi(response)[response.employee_id];

test("one card per leave type the API reported, each with its days taken and the year", () => {
  assert.deepEqual(usageCards(balanceFor(RESPONSE)), [
    { type: "Annual", days: 3, year: 2026 },
    { type: "Sick", days: 2, year: 2026 },
    { type: "Casual", days: 0, year: 2026 },
    { type: "Maternity", days: 0, year: 2026 },
    { type: "Emergency", days: 1, year: 2026 },
  ]);
});

test("the cards carry no total-allowed or remaining figure: there are no entitlements (D40)", () => {
  for (const card of usageCards(balanceFor(RESPONSE))) {
    assert.deepEqual(Object.keys(card).sort(), ["days", "type", "year"]);
  }
});

test("the garbled cards of the first cutover cannot come back: the usage object's own keys are never card types", () => {
  const types = usageCards(balanceFor(RESPONSE)).map((card) => card.type);

  for (const notAType of ["taken", "total", "year", "asOf"]) assert.equal(types.includes(notAType), false, notAType);
});

test("no cards before the usage has loaded, whatever 'before' looks like", () => {
  assert.deepEqual(usageCards(undefined), []);
  assert.deepEqual(usageCards(null), []);
  assert.deepEqual(usageCards({}), []);
});

test("a type with zero days taken is still a card showing 0, not a missing one", () => {
  const casual = usageCards(balanceFor(RESPONSE)).find((card) => card.type === "Casual");

  assert.equal(casual.days, 0);
});

test("the dashboard shows total days taken", () => {
  assert.equal(totalTakenLabel(balanceFor(RESPONSE)), "6 days");
  assert.equal(totalTakenSub(balanceFor(RESPONSE)), "Days taken in 2026");
});

test("zero days taken is shown as 0 days, never as the placeholder", () => {
  const none = balanceFor({ ...RESPONSE, taken: { Annual: 0 }, total: 0 });

  assert.equal(totalTakenLabel(none), "0 days");
});

test("before the usage has loaded the dashboard shows a dash, never an invented number (it used to show 15)", () => {
  for (const missing of [undefined, null, {}]) {
    assert.equal(totalTakenLabel(missing), "—");
    assert.equal(totalTakenSub(missing), "Days taken this year");
  }
});
