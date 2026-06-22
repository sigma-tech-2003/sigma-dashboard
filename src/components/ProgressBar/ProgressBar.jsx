import "./ProgressBar.css";
import { T } from "../../theme/theme";

const ProgressBar = ({ value, max = 100, color = T.primary, h = 6 }) => {
  const p = Math.min(100, Math.round((value / max) * 100));

  return (
    <div
      className="progress"
      style={{
        background: T.border,
        height: h,
      }}
    >
      <div
        className="progress-inner"
        style={{
          width: `${p}%`,
          background: `linear-gradient(90deg, ${color}, ${color}cc)`,
        }}
      />
    </div>
  );
};

export default ProgressBar;