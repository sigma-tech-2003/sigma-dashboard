import "./Stat.css";
import { useRef } from "react";
import { alpha } from "../../theme/theme";
import { useCountUp } from "../../hooks/motion/useCountUp";

const Stat = ({ icon: Icon, label, value, sub, color }) => {
  const valueRef = useRef(null);
  useCountUp(valueRef, value);

  return (
    <div className="stat">
      <div className="stat-header">
        <span className="stat-label">{label}</span>

        {Icon && (
          <div className="stat-icon" style={{ background: alpha(color, 12) }}>
            <Icon size={16} color={color} aria-hidden="true" />
          </div>
        )}
      </div>

      <div ref={valueRef} className={"stat-value" + (String(value).length > 7 ? " stat-value--long" : "")}>{value}</div>

      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
};

export default Stat;
