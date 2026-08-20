import "./PageHeader.css";

const PageHeader = ({ title, description, actions, children }) => (
  <header className="page-header">
    <div className="page-header__content">
      <h1 className="page-header__title">{title}</h1>
      {description && <p className="page-header__description">{description}</p>}
      {children}
    </div>
    {actions && <div className="page-header__actions">{actions}</div>}
  </header>
);

export default PageHeader;
