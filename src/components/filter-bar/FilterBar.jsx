import "./FilterBar.css";

const FilterBar = ({ children, style }) => (
  <div className="filter-bar" style={style}>
    {children}
  </div>
);

export default FilterBar;
