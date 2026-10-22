import "./DetailList.css";

// Label and value pairs for a record's details: a quiet label on the left, the value on the right.
const DetailList = ({ items }) => (
  <dl className="detail-list">
    {items.map(([label, value]) => (
      <div key={label} className="detail-list__row">
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export default DetailList;
