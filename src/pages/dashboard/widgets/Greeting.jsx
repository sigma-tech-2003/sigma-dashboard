// The top of the dashboard: the date, a serif greeting whose words arrive one after another (usePageMotion looks for
// data-word), and one sentence that says what the day holds.
const Greeting = ({ greeting, name, date, children }) => (
  <header className="dash-greeting">
    <div className="dash-date">{date}</div>
    <h1 className="dash-title" aria-label={`${greeting}, ${name}.`}>
      {greeting.split(" ").map((word) => (
        <span key={word} className="dash-title__word" data-word aria-hidden="true">{word}</span>
      ))}
      <span className="dash-title__word" data-word aria-hidden="true"><em>{name}.</em></span>
    </h1>
    {children && <p className="dash-lede">{children}</p>}
  </header>
);

export default Greeting;
