import "./DataTable.css";

const DataTable = ({ children, className = "", tableClassName = "" }) => (
  <div className={"data-table-container " + className}>
    <div className="data-table-scroll">
      <table className={"data-table " + tableClassName}>{children}</table>
    </div>
  </div>
);

export default DataTable;
