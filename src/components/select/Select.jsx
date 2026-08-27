import { useId } from "react";
import "./Select.css";
import "../form-field/FieldHelp.css";
import { T } from "../../theme/theme";

const Select = ({
  label,
  hint,
  error,
  id,
  children,
  style,
  ...props
}) => {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const descriptionId = error ? fieldId + "-error" : hint ? fieldId + "-hint" : undefined;

  return (
    <div className="select-wrapper">
      {label && <label className="select-label" htmlFor={fieldId}>{label}</label>}
      <select
        {...props}
        id={fieldId}
        className="select-field"
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
        style={{
          background: T.card,
          border: "1px solid " + (error ? T.danger : T.border),
          color: T.text,
          ...style,
        }}
      >
        {children}
      </select>
      {error && <div id={fieldId + "-error"} className="field-error">{error}</div>}
      {!error && hint && <div id={fieldId + "-hint"} className="field-hint">{hint}</div>}
    </div>
  );
};

export default Select;
