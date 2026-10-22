import { useId } from "react";
import "../form-field/Field.css";

const Textarea = ({
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
    <div className={"textarea-wrapper " + className}>
      {label && <label className="textarea-label" htmlFor={fieldId}>{label}</label>}
      <textarea
        {...props}
        id={fieldId}
        className="textarea-field"
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      />
      {error && <div id={fieldId + "-error"} className="field-error">{error}</div>}
      {!error && hint && <div id={fieldId + "-hint"} className="field-hint">{hint}</div>}
    </div>
  );
};

export default Textarea;
