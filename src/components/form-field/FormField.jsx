import "./FormField.css";
import "./FieldHelp.css";

const FormField = ({ id, label, hint, error, children, className = "" }) => (
  <div className={"form-field " + className}>
    {label && <label className="form-field__label" htmlFor={id}>{label}</label>}
    {children}
    {error && <div id={id + "-error"} className="field-error">{error}</div>}
    {!error && hint && <div id={id + "-hint"} className="field-hint">{hint}</div>}
  </div>
);

export default FormField;
