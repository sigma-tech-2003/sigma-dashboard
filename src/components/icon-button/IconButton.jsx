import "./IconButton.css";

// An icon-only control. The label is required: it is the accessible name and the tooltip, so an icon is never the only clue.
const IconButton = ({ icon: Icon, label, variant = "default", onClick, type = "button", disabled, ...rest }) => (
  <button
    {...rest}
    type={type}
    className={`icon-button icon-button--${variant}`}
    aria-label={label}
    title={label}
    onClick={onClick}
    disabled={disabled}
  >
    <Icon size={16} aria-hidden="true" />
  </button>
);

export default IconButton;
