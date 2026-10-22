// Every status or role the app can show as a pill, with its tone and sentence-case label. Kept apart from Badge.jsx so a
// test can check coverage without rendering. A tone maps to a --color-<tone> and --color-<tone>-glow pair in tokens.css.
export const BADGE_STATUSES = {
  // employment, department, project
  active: { tone: "success", label: "Active" },
  inactive: { tone: "danger", label: "Inactive" },
  draft: { tone: "muted", label: "Draft" },
  completed: { tone: "primary", label: "Completed" },
  // leave and payroll
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  pending: { tone: "warning", label: "Pending" },
  cancelled: { tone: "muted", label: "Cancelled" },
  processed: { tone: "primary", label: "Processed" },
  // attendance
  present: { tone: "success", label: "Present" },
  absent: { tone: "danger", label: "Absent" },
  late: { tone: "warning", label: "Late" },
  leave: { tone: "secondary", label: "On leave" },
  // roles
  superuser: { tone: "purple", label: "Superuser" },
  admin: { tone: "purple", label: "Admin" },
  hr: { tone: "secondary", label: "HR" },
  manager: { tone: "primary", label: "Manager" },
  tl: { tone: "primary", label: "Team lead" },
  employee: { tone: "muted", label: "Employee" },
};

export const BADGE_TONES = ["success", "danger", "warning", "primary", "secondary", "purple", "muted"];

// "On Leave", "on_leave" and "leave" are the same status
const normalize = (value) => {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key === "on_leave" ? "leave" : key;
};

export const resolveBadge = (status) => {
  const known = BADGE_STATUSES[normalize(status)];
  if (known) return known;
  const text = String(status ?? "").trim();
  return { tone: "muted", label: text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown" };
};
