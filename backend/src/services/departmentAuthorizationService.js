import { HttpError } from "../utils/httpError.js";

/**
 * Departments write authority: admin only. Deliberately NOT COMPANY_WIDE_ROLES (which also
 * includes hr) -- HR can read departments but every write is denied, matching
 * firestore.rules (768, 773, 786) and docs/migration-plan.md's Phase 5 note. Unlike
 * employees, there is no row-level scope to enforce here at all: departmentRepository.js's
 * read side is already a pure role gate, not a scope filter, and no department write
 * depends on who the target "belongs to".
 */
export function assertCanWriteDepartment(principal) {
  if (principal?.role !== "admin") {
    throw new HttpError(403, "role_not_allowed", "Only admin may manage departments.");
  }
}
