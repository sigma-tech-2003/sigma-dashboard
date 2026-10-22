import "./Avatar.css";
import { aColor, initials } from "../../utils/helpers";

const Avatar = ({ emp, size = 36 }) => (
  <div
    className="avatar"
    style={{
      width: size,
      height: size,
      background: aColor(emp.id),
      fontSize: Math.max(12, size * 0.38),
    }}
  >
    {initials(emp.name)}
  </div>
);

export default Avatar;