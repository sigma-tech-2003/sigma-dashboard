import { Search } from "lucide-react";
import "./SearchBar.css";

const SearchBar = ({ value, onChange, placeholder, ariaLabel, style, ...props }) => (
  <div className="search-bar" style={style}>
    <Search className="search-bar__icon" size={14} />
    <input
      {...props}
      value={value}
      onChange={onChange}
      aria-label={ariaLabel || placeholder}
      placeholder={placeholder}
      className="search-bar__input"
    />
  </div>
);

export default SearchBar;
