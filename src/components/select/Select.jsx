import "./Select.css";
import { T } from "../../theme/theme";

const Select = ({ label, children, ...p }) => (
  <div className="select-wrapper">
    {label && <label className="select-label">{label}</label>}

    <select
      {...p}
      className="select-field"
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        color: T.text,
      }}
    >
      {children}
    </select>
  </div>
);

export default Select;