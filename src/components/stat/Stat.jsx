import "./Stat.css";
import { T } from "../../theme/theme";

const Stat = ({ icon: Icon, label, value, sub, color, glow }) => (
  <div
    className="stat"
    style={{
      boxShadow: `0 0 0 1px ${T.border}`,
    }}
    onMouseEnter={(e) =>
      (e.currentTarget.style.borderColor = color)
    }
    onMouseLeave={(e) =>
      (e.currentTarget.style.borderColor = T.border)
    }
  >
    <div className="stat-header">
      <span className="stat-label">{label}</span>

      <div
        className="stat-icon"
        style={{ background: `${color}18` }}
      >
        <Icon size={16} color={color} />
      </div>
    </div>

    <div className="stat-value">{value}</div>

    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

export default Stat;