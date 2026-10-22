import "./PageSkeleton.css";
import SkeletonLoader from "../skeleton-loader/SkeletonLoader";
import TableSkeleton from "../data-table/TableSkeleton";

// What a page looks like before its data arrives: a heading, a row of figures and a table. It stands in for the page inside
// the real shell, so the sidebar and top bar are there from the first frame and nothing jumps when the data lands.
const PageSkeleton = ({ label = "Loading" }) => (
  <div className="page-skeleton" role="status" aria-busy="true" aria-label={label}>
    <div className="page-skeleton__header">
      <SkeletonLoader width={220} height={28} />
      <SkeletonLoader width={320} height={14} />
    </div>
    <div className="page-skeleton__stats">
      {[0, 1, 2, 3].map((item) => (
        <SkeletonLoader key={item} width="100%" height={104} borderRadius="var(--radius-xl)" />
      ))}
    </div>
    <TableSkeleton columns={5} rows={6} label={label} />
  </div>
);

export default PageSkeleton;
