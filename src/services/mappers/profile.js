import { MappingError, nullToEmpty } from "./common.js";

// GET /auth/me -> the session `user` the app already uses (D32). Exactly these nine fields, all strings: the
// Firebase flow validated this exact field set, and `App.jsx` will not render the workspace unless `id`, `role`
// and `dept` are strings. `dept` is the department NAME (D33), "" for an account with no department.

const ROLES = new Set(["admin", "hr", "manager", "tl", "employee"]);

export const SESSION_USER_FIELDS = Object.freeze([
  "id", "name", "email", "phone", "dept", "pos", "joinDate", "empId", "role",
]);

export function fromApi(profile) {
  const valid = profile != null
    && typeof profile === "object"
    && typeof profile.id === "string" && profile.id.trim() !== ""
    && typeof profile.full_name === "string" && profile.full_name.trim() !== ""
    && typeof profile.email === "string" && profile.email.includes("@")
    && ROLES.has(profile.role);
  if (!valid) throw new MappingError("malformed-profile", "The profile response could not be verified.");

  return {
    id: profile.id,
    name: profile.full_name,
    email: profile.email,
    phone: nullToEmpty(profile.phone),
    dept: nullToEmpty(profile.department_name),
    pos: nullToEmpty(profile.position_title),
    joinDate: nullToEmpty(profile.joined_on),
    empId: nullToEmpty(profile.employee_number),
    role: profile.role,
  };
}
