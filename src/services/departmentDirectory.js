// Department name <-> id pairs the write mappers need (D33).
//
// The pages identify a department by NAME; the API by id; and only admin and hr can read the departments list.
// A manager or tl creating or editing an employee still has to send a department_id. They always have employees
// and projects in view that carry BOTH the id and the name, so the data hooks feed every pair they see into this
// directory, and the services read it back when they translate a write. Admin and hr additionally feed it the
// full list, so a department with no employees yet can still be chosen.
//
// A module-level cache, deliberately: pages import the service functions directly, so a service has no other
// way to reach what the hooks have loaded. It is emptied on sign-out.

const byId = new Map();

export const departmentDirectory = {
  /** @param {Array<{ id: string, name: string }>} pairs */
  learn(pairs) {
    for (const pair of pairs ?? []) {
      if (pair && typeof pair.id === "string" && pair.id && typeof pair.name === "string" && pair.name) {
        byId.set(pair.id, pair.name);
      }
    }
  },

  /** Pairs from page-shaped records that carry `departmentId` plus a name under `nameKey` ("dept" or "department"). */
  learnFromRecords(records, nameKey) {
    this.learn((records ?? []).map((record) => ({ id: record?.departmentId, name: record?.[nameKey] })));
  },

  /** The lookup shape the mappers take: [{ id, name }]. */
  lookup() {
    return [...byId].map(([id, name]) => ({ id, name }));
  },

  clear() {
    byId.clear();
  },
};
