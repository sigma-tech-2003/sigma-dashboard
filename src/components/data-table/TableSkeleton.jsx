import "./DataTable.css";
import SkeletonLoader from "../skeleton-loader/SkeletonLoader";

// A table-shaped placeholder: a header strip and rows of bars, announced once as "Loading" rather than bar by bar.
const TableSkeleton = ({ columns = 5, rows = 6, label = "Loading" }) => (
  <div className="data-table-container table-skeleton" role="status" aria-busy="true" aria-label={label}>
    <div className="table-skeleton__row table-skeleton__row--head">
      {Array.from({ length: columns }, (_, column) => (
        <SkeletonLoader key={column} width="50%" height={12} />
      ))}
    </div>
    {Array.from({ length: rows }, (_, row) => (
      <div key={row} className="table-skeleton__row">
        {Array.from({ length: columns }, (_, column) => (
          <SkeletonLoader key={column} width={column === 0 ? "75%" : "60%"} height={14} />
        ))}
      </div>
    ))}
  </div>
);

export default TableSkeleton;
