import "./FormFeedback.css";

const FormFeedback = ({ status = "error", children }) => {
  if (!children) return null;

  return (
    <div className={"form-feedback form-feedback--" + status} role="status">
      {children}
    </div>
  );
};

export default FormFeedback;
