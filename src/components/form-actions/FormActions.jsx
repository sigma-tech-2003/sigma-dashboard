import "./FormActions.css";

const FormActions = ({ children, align = "end" }) => (
  <div className={"form-actions form-actions--" + align}>{children}</div>
);

export default FormActions;
