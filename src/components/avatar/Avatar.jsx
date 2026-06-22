import "./Avatar.css";
import { aColor, initials } from "../../utils/helpers";

const Avatar = ({ emp, size = 36 }) => (
  <div
    className="avatar"
    style={{
      width: size,
      height: size,
      background: aColor(emp.id),
      fontSize: size * 0.33,
      border: `2px solid ${aColor(emp.id)}40`,
    }}
  >
    {initials(emp.name)}
  </div>
);

export default Avatar;