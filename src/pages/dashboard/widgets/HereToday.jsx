import Avatar from "../../../components/avatar/Avatar";
import CountUp from "../../../components/count-up/CountUp";

const ORDER = { in: 0, not: 1, out: 2 };
const LABEL = { in: "In", not: "Not in yet", out: "Away" };

const tipFor = (person) => {
  if (person.state === "in") return `${person.employee.name} · ${person.late ? "late, " : ""}in${person.checkIn ? ` at ${person.checkIn}` : ""}`;
  if (person.state === "out") return `${person.employee.name} · ${person.status === "absent" ? "absent" : "on leave"}`;
  return `${person.employee.name} · not in yet`;
};

// Keep a face's tooltip on screen: nudge it sideways when the face is near an edge of the window.
const keepTipOnScreen = (event) => {
  const face = event.currentTarget;
  const tip = face.querySelector(".face__tip");
  if (!tip) return;
  const box = face.getBoundingClientRect();
  const half = tip.offsetWidth / 2;
  const centre = box.left + box.width / 2;
  const margin = 12;
  const left = Math.max(margin, Math.min(window.innerWidth - margin - tip.offsetWidth, centre - half));
  tip.style.setProperty("--tip-shift", `${left - (centre - half)}px`);
};

const names = (people) => {
  const first = people.slice(0, 2).map((person) => person.employee.name);
  return people.length > 2 ? `${first.join(", ")} and ${people.length - 2} more` : first.join(" and ");
};

// Who is here right now, as faces, and how many are expected on each of the next working days.
const HereToday = ({ presence, week }) => {
  const { people, counts } = presence;
  const sorted = [...people].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const notIn = people.filter((person) => person.state === "not");
  const out = people.filter((person) => person.state === "out");
  const nextAway = week.find((day, index) => index > 0 && day.count < day.total);

  return (
    <section className="card dash-today" aria-labelledby="todayTitle">
      <div className="sh"><h2 id="todayTitle">Here today</h2><span>from clock-ins</span></div>
      <div className="today-count">
        <CountUp value={String(counts.in)} className="today-count__n" />
        <span>of {counts.total} {counts.total === 1 ? "person is" : "people are"} in</span>
      </div>

      <ul className="faces" aria-label="Everyone, and whether they are in">
        {sorted.map((person) => (
          <li key={person.employee.id} className={`face face--${person.state}`} tabIndex={0} aria-label={tipFor(person)} onPointerEnter={keepTipOnScreen} onFocus={keepTipOnScreen}>
            <Avatar emp={person.employee} size={46} />
            <i className="face__dot" aria-hidden="true" />
            <span className="face__tip" aria-hidden="true">{tipFor(person)}</span>
          </li>
        ))}
      </ul>

      <div className="key" aria-hidden="true">
        {["in", "not", "out"].map((state) => <span key={state}><i className={`key__dot key__dot--${state}`} />{LABEL[state]}</span>)}
      </div>

      <ol className="week" aria-label="People expected in over the next working days">
        {week.map((day) => (
          <li key={day.iso} className={"week__day" + (day.today ? " week__day--today" : "")}>
            <b className="num">{day.count}</b>
            <span>{day.today ? `${day.label}, today` : day.label}</span>
          </li>
        ))}
      </ol>

      <p className="today-sum">
        {notIn.length > 0 && <><b>{names(notIn)}</b> {notIn.length === 1 ? "is" : "are"} not in yet. </>}
        {out.length > 0 && <><b>{names(out)}</b> {out.length === 1 ? "is" : "are"} away today. </>}
        {notIn.length === 0 && out.length === 0 && "Everyone is in. "}
        {nextAway && <>Fewest in on <b>{nextAway.label}</b>: {nextAway.count} of {nextAway.total}.</>}
      </p>
    </section>
  );
};

export default HereToday;
