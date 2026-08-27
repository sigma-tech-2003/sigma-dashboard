import { useId } from "react";
import "./Input.css";
import "../form-field/FieldHelp.css";
import { T } from "../../theme/theme";

const Input = ({
  label,
  hint,
  error,
  id,
  onFocus,
  onBlur,
  style,
  ...props
}) => {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const descriptionId = error ? fieldId + "-error" : hint ? fieldId + "-hint" : undefined;

  return (
    <div className="input-wrapper">
      {label && <label className="input-label" htmlFor={fieldId}>{label}</label>}
      <input
        {...props}
        id={fieldId}
        className="input-field"
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
        style={{
          background: T.card,
          border: "1px solid " + (error ? T.danger : T.border),
          color: T.text,
          ...style,
        }}
        onFocus={(event) => {
          event.target.style.borderColor = error ? T.danger : T.primary;
          onFocus?.(event);
        }}
        onBlur={(event) => {
          event.target.style.borderColor = error ? T.danger : T.border;
          onBlur?.(event);
        }}
      />
      {error && <div id={fieldId + "-error"} className="field-error">{error}</div>}
      {!error && hint && <div id={fieldId + "-hint"} className="field-hint">{hint}</div>}
    </div>
  );
};

export default Input;
