import "./PersonCell.css";
import Avatar from "../avatar/Avatar";

// A person in a table row or list: avatar, name, and an optional quieter second line (department, position, id).
const PersonCell = ({ emp, sub, size = 32 }) => {
  if (!emp) return <span className="person-cell__name">Unknown employee</span>;

  return (
    <div className="person-cell">
      <Avatar emp={emp} size={size} />
      <div className="person-cell__text">
        <span className="person-cell__name">{emp.name}</span>
        {sub && <span className="person-cell__sub">{sub}</span>}
      </div>
    </div>
  );
};

export default PersonCell;
