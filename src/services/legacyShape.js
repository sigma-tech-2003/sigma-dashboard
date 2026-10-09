// Firestore stamped every document it returned with `_docId`, and some pages still require it (EmployeesPage
// refuses to edit or remove an employee that lacks one). An API record has only `id`, which for the API IS the
// canonical identifier, so the data layer adds `_docId` as a copy of it. This lives here, not in the mappers,
// so the mappers stay free of Firestore leftovers (D39); it goes when the pages stop asking for it.
export const withDocId = (record) => ({ ...record, _docId: record.id });

/** The record with this id (compared as strings) from a list of page-shaped records, or null. */
export const findRecordById = (records, id) =>
  (Array.isArray(records) ? records : []).find((record) => String(record?.id) === String(id)) ?? null;
