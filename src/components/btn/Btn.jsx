import "./Btn.css";
import { T } from "../../theme/theme";

const Btn = ({
  children,
  variant = "primary",
  sm,
  onClick,
  type = "button",
  disabled,
}) => {
  const styles = {
    primary: {
      background: T.primary,
      color: "#fff",
      border: `1px solid ${T.primary}`,
    },
    ghost: {
      background: "transparent",
      color: T.muted,
      border: `1px solid ${T.border}`,
    },
    success: {
      background: T.success,
      color: "#fff",
      border: `1px solid ${T.success}`,
    },
    danger: {
      background: T.danger,
      color: "#fff",
      border: `1px solid ${T.danger}`,
    },
    warning: {
      background: T.warning,
      color: "#000",
      border: `1px solid ${T.warning}`,
    },
    outline: {
      background: "transparent",
      color: T.primary,
      border: `1px solid ${T.primary}`,
    },
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`btn ${sm ? "btn-sm" : "btn-md"}`}
      style={{
        ...styles[variant],
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
};

export default Btn;