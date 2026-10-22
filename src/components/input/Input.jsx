import { useId } from "react";
import "../form-field/Field.css";

const Input = ({
  label,
  hint,
  error,
  id,
  className = "",
  ...props
}) => {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const descriptionId = error ? fieldId + "-error" : hint ? fieldId + "-hint" : undefined;

  return (
    <div className={"input-wrapper " + className}>
      {label && <label className="input-label" htmlFor={fieldId}>{label}</label>}
      <input
        {...props}
        id={fieldId}
        className="input-field"
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      />
      {error && <div id={fieldId + "-error"} className="field-error">{error}</div>}
      {!error && hint && <div id={fieldId + "-hint"} className="field-hint">{hint}</div>}
    </div>
  );
};

export default Input;
