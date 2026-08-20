import Card from "../card/Card";

const SectionCard = ({ title, actions, children, style }) => (
  <Card title={title} right={actions} style={style}>
    {children}
  </Card>
);

export default SectionCard;
