/**
 * The five leave types. They keep Firestore's title-case vocabulary, matching the `leave_type` enum in
 * migration 001, so the frontend and the database share one vocabulary.
 *
 * Since D40 the type is a label and nothing more: there are no entitlements and no pools, so it decides
 * nothing about how many days may be taken. It is still recorded, and a days-taken figure is reported per
 * type.
 */
export const LEAVE_TYPES = Object.freeze(["Annual", "Sick", "Casual", "Maternity", "Emergency"]);
