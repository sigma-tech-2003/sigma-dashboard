import "./Input.css";
import { T } from "../../theme/theme";

const Input = ({ label, ...p }) => (
  <div className="input-wrapper">
    {label && <label className="input-label">{label}</label>}

    <input
      {...p}
      className="input-field"
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        color: T.text,
        ...p.style,
      }}
      onFocus={(e) => (e.target.style.borderColor = T.primary)}
      onBlur={(e) => (e.target.style.borderColor = T.border)}
    />
  </div>
);

export default Input;