// What the Department dropdown on the Add Employee form offers, per role (D42).
//
//   admin    every active department, plus "+ Create department" (the only role that may write departments)
//   hr       every active department and a hint that only an admin can add one (hr reads the list, cannot write it)
//   manager  their own department, as the single option, locked
//   tl       their own department, as the single option, locked
//
// This only decides what to SHOW. The API is the authority: it refuses a department write from anyone but an admin,
// and an employee outside the creator's department from a manager or tl.
//
// Manager and tl cannot read the departments list at all (D33), so for them `departments` is empty; the single
// locked option comes from their own session user, which is also why their field is no longer blank.

export const CREATE_DEPARTMENT_VALUE = "__create_department__";
export const HR_DEPARTMENT_HINT = "Only an administrator can add a new department.";

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * @param {{ role?: string, dept?: string }} user    the signed-in user
 * @param {Array<{ name: string, status?: string }>} departments  the loaded list (admin and hr only)
 * @param {string} [selected]  the department currently chosen in the form
 * @returns {{ options: Array<{ value: string, label: string }>, locked: boolean, canCreate: boolean, hint: string }}
 */
export function departmentOptions(user, departments = [], selected = "") {
  const role = user?.role;
  const own = typeof user?.dept === "string" ? user.dept.trim() : "";

  if (role === "manager" || role === "tl") {
    return {
      options: own ? [{ value: own, label: own }] : [],
      locked: true,
      canCreate: false,
      hint: "",
    };
  }

  const options = (Array.isArray(departments) ? departments : [])
    .filter((department) => department?.status === "Active" && typeof department.name === "string" && department.name)
    .map((department) => ({ value: department.name, label: department.name }));

  // A department that was just created and chosen stays selectable until the polled list includes it.
  const chosen = typeof selected === "string" ? selected.trim() : "";
  if (chosen && chosen !== CREATE_DEPARTMENT_VALUE && !options.some((option) => same(option.value, chosen))) {
    options.push({ value: chosen, label: chosen });
  }

  return {
    options,
    locked: false,
    canCreate: role === "admin",
    hint: role === "hr" ? HR_DEPARTMENT_HINT : "",
  };
}

/**
 * The sentence shown under the inline "Create department" field. Never the server's own wording: a duplicate name,
 * a refusal and everything else each have their own plain message.
 */
export function createDepartmentMessage(error, name = "") {
  if (error?.name === "ApiError") {
    if (error.status === 409) return `A department named "${name}" already exists.`;
    if (error.status === 403) return "Only an administrator can create departments.";
    if (error.status === 400) return "Enter a valid department name.";
    if (error.status === 0 || error.status >= 502) return "Unable to connect. Check your connection and try again.";
  }
  return "The department could not be created. Please try again.";
}
