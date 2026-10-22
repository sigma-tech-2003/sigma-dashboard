import "./DataTable.css";
import { useRef } from "react";
import { useRowHighlight } from "../../hooks/motion/useRowHighlight";
import TableSkeleton from "./TableSkeleton";

// children stay a <thead> and <tbody>. Give each <td> a data-label (its column name) and, below 640px, every row becomes a
// small card with the label beside the value, so nothing scrolls sideways. Mark the cell that names the row with
// data-primary and it becomes the card's heading. A table that cannot reflow passes reflow={false} and scrolls instead.
//   loading  shows a skeleton of `columns` x `rows` instead of the table
//   empty    a node (usually an <EmptyState>) shown instead of the table when there is nothing to list
// Where there is a pointer, one highlight bar follows it down the rows (useRowHighlight).
const DataTable = ({ children, className = "", tableClassName = "", loading = false, empty = null, columns = 5, rows = 6, reflow = true, label }) => {
  const containerRef = useRef(null);
  useRowHighlight(containerRef, `${loading}-${Boolean(empty)}`);

  if (loading) return <TableSkeleton columns={columns} rows={rows} label={label} />;
  if (empty) return empty;

  return (
    <div ref={containerRef} className={"data-table-container " + className}>
      <span className="data-table-highlight" data-row-highlight aria-hidden="true" />
      <div className="data-table-scroll">
        <table className={"data-table " + (reflow ? "data-table--reflow " : "") + tableClassName} aria-label={label}>{children}</table>
      </div>
    </div>
  );
};

export default DataTable;
