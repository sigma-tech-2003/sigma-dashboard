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
      bg: T.primaryTint,
      c: T.primary,
      label: "Processed",
    },
    draft: {
      bg: T.mutedGlow,
      c: T.muted,
      label: "Draft",
    },
    admin: {
      bg: T.purpleGlow,
      c: T.purple,
      label: "Admin",
    },
    hr: {
      bg: T.secondaryGlow,
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
      bg: T.mutedGlow,
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
