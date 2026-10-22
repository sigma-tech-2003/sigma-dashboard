import { useId } from "react";
import "../form-field/Field.css";

const Select = ({
  label,
  hint,
  error,
  id,
  children,
  className = "",
  ...props
}) => {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const descriptionId = error ? fieldId + "-error" : hint ? fieldId + "-hint" : undefined;

  return (
    <div className={"select-wrapper " + className}>
      {label && <label className="select-label" htmlFor={fieldId}>{label}</label>}
      <select
        {...props}
        id={fieldId}
        className="select-field"
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      >
        {children}
      </select>
      {error && <div id={fieldId + "-error"} className="field-error">{error}</div>}
      {!error && hint && <div id={fieldId + "-hint"} className="field-hint">{hint}</div>}
    </div>
  );
};

export default Select;
