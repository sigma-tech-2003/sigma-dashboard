import "./PageSkeleton.css";
import SkeletonLoader from "../skeleton-loader/SkeletonLoader";
import TableSkeleton from "../data-table/TableSkeleton";

const Lines = ({ rows = 3 }) => (
  <div className="sk-lines">
    {Array.from({ length: rows }, (_, row) => (
      <div key={row} className="sk-line">
        <SkeletonLoader width={36} height={36} borderRadius="50%" />
        <div className="sk-line__text">
          <SkeletonLoader width="45%" height={14} />
          <SkeletonLoader width="75%" height={12} />
        </div>
      </div>
    ))}
  </div>
);

// What a page looks like before its data arrives. It stands in for the page inside the real shell, so the sidebar and
// top bar are there from the first frame and nothing jumps when the data lands. The dashboard has its own shape: the
// greeting, the two cards that lead it, the wide calendar, and three smaller cards.
const PageSkeleton = ({ label = "Loading", variant = "page" }) => {
  if (variant === "dashboard") {
    return (
      <div className="page-skeleton" role="status" aria-busy="true" aria-label={label}>
        <SkeletonLoader width={150} height={14} />
        <div className="sk-title"><SkeletonLoader width="min(460px, 80%)" height={46} borderRadius="var(--radius-md)" /></div>
        <SkeletonLoader width="min(580px, 90%)" height={16} />
        <div className="sk-grid">
          <div className="card sk-7"><SkeletonLoader width={110} height={16} /><Lines rows={3} /></div>
          <div className="card sk-5"><SkeletonLoader width={110} height={16} /><div className="sk-big"><SkeletonLoader width={90} height={56} /></div><div className="sk-faces">{Array.from({ length: 7 }, (_, i) => <SkeletonLoader key={i} width={46} height={46} borderRadius="50%" />)}</div></div>
          <div className="card sk-12"><SkeletonLoader width={220} height={16} /><div className="sk-cal"><SkeletonLoader width="100%" height={120} borderRadius="var(--radius-md)" /></div></div>
          {[0, 1, 2].map((card) => (
            <div key={card} className="card sk-4"><SkeletonLoader width={110} height={16} /><div className="sk-big"><SkeletonLoader width={150} height={44} /></div><SkeletonLoader width="70%" height={12} /></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page-skeleton" role="status" aria-busy="true" aria-label={label}>
      <div className="page-skeleton__header">
        <SkeletonLoader width={220} height={36} />
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
};

export default PageSkeleton;
