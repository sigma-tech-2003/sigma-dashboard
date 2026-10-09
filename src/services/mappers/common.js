// Shared by the per-resource mappers (D39). Pure: no React, no network, no Firebase, so a plain Node process
// can load every mapper and `node --test` can run them.
//
// Direction convention in every mapper module:
//   fromApi(row)                  API row (snake_case, relational) -> the record shape the pages consume
//   toApiCreate(record, context)  a page's create payload          -> the API's create body
//   toApiUpdate(changes, context) a page's update payload          -> the API's PATCH body
// `context` is `{ original, departments }`, either optional. With `original` (the page-shaped record being
// edited) an update emits only the keys that actually changed, so a full-form save does not re-send
// role/email/department the server may gate; without it, an update emits whatever it is given.

export class MappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MappingError";
    this.code = code;
  }
}

export const MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

export const isBlank = (value) => value == null || (typeof value === "string" && value.trim() === "");

/** "" and undefined become null: the API takes null for "no value" where the pages use an empty string. */
export const emptyToNull = (value) => (isBlank(value) ? null : value);

/** null and undefined become "": the pages render and bind empty strings, never null. */
export const nullToEmpty = (value) => (value == null ? "" : value);

export const trimmed = (value) => (typeof value === "string" ? value.trim() : value);

/** A string id, or "" for none. Ids are UUIDs: they are passed through as the strings they are, never coerced. */
export const idOrEmpty = (value) => (value == null ? "" : String(value));

export const hasOwn = (object, key) => Object.hasOwn(object ?? {}, key);

/**
 * Applies a field table to a page-shaped record and returns only the API keys that are present on it.
 * `fields` is [pageKey, apiKey, convert?]. A page key that is absent is skipped (so a partial update stays
 * partial); a present one is converted and kept even if it converts to null.
 */
export function pickMapped(record, fields) {
  const body = {};
  for (const [pageKey, apiKey, convert] of fields) {
    if (!hasOwn(record, pageKey)) continue;
    body[apiKey] = convert ? convert(record[pageKey]) : record[pageKey];
  }
  return body;
}

const sameValue = (left, right) => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => String(item) === String(right[index]));
  }
  if (left == null || right == null) return (left ?? "") === (right ?? "");
  return left === right;
};

/**
 * With `original`, keeps only the page keys whose value differs from it. Without, returns `changes` untouched.
 */
export function onlyChanged(changes, original) {
  if (!original) return changes;
  const kept = {};
  for (const key of Object.keys(changes)) {
    if (!sameValue(changes[key], original[key])) kept[key] = changes[key];
  }
  return kept;
}

/**
 * The department id for a page-side department NAME. Pages identify departments by name; the API by id, and
 * only admin and hr can read the list (D33). Resolution order:
 *   1. the name is in the supplied `departments` lookup -> that id;
 *   2. otherwise, a `departmentId` carried on the record from a read -> that id (the name did not change);
 *   3. no name at all -> undefined (omit the field);
 *   4. a name that resolves to nothing -> MappingError, never silently dropped.
 */
export function resolveDepartmentId({ name, departmentId, departments }) {
  const wanted = trimmed(name);
  if (Array.isArray(departments) && !isBlank(wanted)) {
    const match = departments.find((department) => department?.name === wanted);
    if (match) return String(match.id);
  }
  if (!isBlank(departmentId)) return String(departmentId);
  if (isBlank(wanted)) return undefined;
  throw new MappingError("unknown-department", `No department named "${wanted}" is known.`);
}
