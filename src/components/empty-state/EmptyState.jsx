import "./EmptyState.css";

const EmptyState = ({ icon: Icon, title, description, children, className = "" }) => (
  <div className={"empty-state " + className}>
    {Icon && <Icon className="empty-state__icon" size={32} />}
    {title && <div className="empty-state__title">{title}</div>}
    {description && <div className="empty-state__description">{description}</div>}
    {children}
  </div>
);

export default EmptyState;
