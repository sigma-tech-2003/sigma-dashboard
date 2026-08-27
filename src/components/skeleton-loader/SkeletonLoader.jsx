import "./SkeletonLoader.css";

const SkeletonLoader = ({ width = "100%", height = 16, borderRadius = "var(--radius-md)" }) => (
  <div
    className="skeleton-loader"
    aria-hidden="true"
    style={{ width, height, borderRadius }}
  />
);

export default SkeletonLoader;
