import "./Badge.css";
import { useRef } from "react";
import { useChangePulse } from "../../hooks/motion/useChangePulse";
import { resolveBadge } from "./badgeStatuses";

// A status pill: a dot and a label in the tone's colour on a tint of itself. Colour is never the only signal; the label is
// always there. When the status changes while it is on screen (Pending to Approved) the pill pops once.
const Badge = ({ s }) => {
  const ref = useRef(null);
  const { tone, label } = resolveBadge(s);
  useChangePulse(ref, label);

  return (
    <span ref={ref} className={`badge badge--${tone}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
};

export default Badge;
