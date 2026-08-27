import "./Card.css";

const Card = ({ title, right, children, style }) => (
  <div className="card" style={style}>
    {(title || right) && (
      <div className="card-header">
        {title && <div className="card-title">{title}</div>}
        {right}
      </div>
    )}
    {children}
  </div>
);

export default Card;
