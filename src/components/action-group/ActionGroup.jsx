import "./ActionGroup.css";

const ActionGroup = ({ children, className = "" }) => (
  <div className={"action-group " + className}>{children}</div>
);

export default ActionGroup;
