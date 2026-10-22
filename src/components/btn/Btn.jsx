import "./Btn.css";

// Variants are classes in Btn.css, so they follow the theme and show hover, focus and disabled states without JavaScript.
const Btn = ({
  children,
  variant = "primary",
  sm,
  onClick,
  type = "button",
  disabled,
  ...rest
}) => (
  <button
    {...rest}
    type={type}
    onClick={onClick}
    disabled={disabled}
    className={`btn btn--${variant} ${sm ? "btn-sm" : "btn-md"}`}
  >
    {children}
  </button>
);

export default Btn;
