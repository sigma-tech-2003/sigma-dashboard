import "./Badge.css";
import { T } from "../../theme/theme";

const Badge = ({ s }) => {
  const map = {
    active: {
      bg: T.successGlow,
      c: T.success,
      label: "Active",
    },
    inactive: {
      bg: T.dangerGlow,
      c: T.danger,
      label: "Inactive",
    },
    approved: {
      bg: T.successGlow,
      c: T.success,
      label: "Approved",
    },
    rejected: {
      bg: T.dangerGlow,
      c: T.danger,
      label: "Rejected",
    },
    pending: {
      bg: T.warningGlow,
      c: T.warning,
      label: "Pending",
    },
    processed: {
      bg: "#1d6fec20",
      c: T.primary,
      label: "Processed",
    },
    draft: {
      bg: "#5a749920",
      c: T.muted,
      label: "Draft",
    },
    admin: {
      bg: "#8b5cf620",
      c: T.purple,
      label: "Admin",
    },
    hr: {
      bg: "#00c2cb20",
      c: T.secondary,
      label: "HR",
    },
    employee: {
      bg: T.primaryGlow,
      c: T.primary,
      label: "Employee",
    },
  };

  const m =
    map[s?.toLowerCase()] || {
      bg: "#5a749920",
      c: T.muted,
      label: s,
    };

  return (
    <span
      className="badge"
      style={{
        background: m.bg,
        color: m.c,
        borderColor: `${m.c}30`,
      }}
    >
      {m.label}
    </span>
  );
};

export default Badge;