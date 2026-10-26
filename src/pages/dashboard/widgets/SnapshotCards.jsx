import Avatar from "../../../components/avatar/Avatar";
import Btn from "../../../components/btn/Btn";
import ChartReveal from "../../../components/chart-reveal/ChartReveal";
import CountUp from "../../../components/count-up/CountUp";
import PersonCell from "../../../components/person-cell/PersonCell";
import { fmt } from "../../../utils/helpers";
import { formatDay } from "../dashboardData";

const STEPS = ["Drafted", "In review", "Processed"];
const STAGE_ON = { none: 0, review: 2, done: 3 };

// ---- Payroll ----

export const PayrollCard = ({ snapshot, trend, navigate }) => {
  const on = STAGE_ON[snapshot.stage];
  const max = Math.max(...trend.data.map((month) => month.total), 1);
  const change = snapshot.changePct;

  return (
    <section className="card dash-pay" aria-labelledby="payTitle">
      <div className="sh"><h2 id="payTitle">{snapshot.monthName} payroll</h2><span>{snapshot.isCurrent ? "this month" : `${snapshot.year}`}</span></div>
      <CountUp value={fmt(snapshot.total)} className="figure" as="div" />
      <p className="sub">
        {snapshot.processed} {snapshot.processed === 1 ? "person" : "people"} paid
        {change !== null && ` · ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% on last month`}
        {snapshot.drafts > 0 && ` · ${snapshot.drafts} still in draft`}
      </p>

      <ol className="steps" aria-label="Payroll progress">
        {STEPS.map((step, index) => (
          <li key={step} className={"steps__step" + (index < on ? " steps__step--on" : "") + (snapshot.stage === "review" && index === 1 ? " steps__step--now" : "")}>{step}</li>
        ))}
      </ol>

      {trend.hasData && (
        <ChartReveal height={96}>
          <div className="months" role="img" aria-label="Net payroll processed in each of the last six months">
            {trend.data.map((month, index) => (
              <div key={month.m} className="months__col" title={`${month.m}: ${fmt(month.total)}`}>
                <i className={index === trend.data.length - 1 ? "months__bar months__bar--now" : "months__bar"} style={{ height: `${Math.max(4, Math.round((month.total / max) * 64))}px`, "--i": index }} />
                <span>{month.m}</span>
              </div>
            ))}
          </div>
        </ChartReveal>
      )}

      <Btn onClick={() => navigate("payroll")}>{snapshot.stage === "review" ? "Review payroll" : snapshot.stage === "none" ? "Start payroll" : "Open payroll"}</Btn>
    </section>
  );
};

// ---- People ----

const SPLIT_SHADES = ["var(--color-primary)", "color-mix(in srgb, var(--color-primary) 55%, var(--color-card))", "color-mix(in srgb, var(--color-primary) 30%, var(--color-card))", "var(--color-border-light)"];

export const PeopleCard = ({ snapshot, label = "People" }) => {
  const joiners = snapshot.joiners.length ? snapshot.joiners : snapshot.latestJoiner ? [snapshot.latestJoiner] : [];

  return (
    <section className="card dash-people" aria-labelledby="peopleTitle">
      <div className="sh"><h2 id="peopleTitle">{label}</h2><span>active</span></div>
      <CountUp value={String(snapshot.total)} className="figure" as="div" />
      <p className="sub">
        {snapshot.joinedRecently > 0
          ? `${snapshot.joinedRecently} joined in the last 30 days`
          : "Nobody joined in the last 30 days"}
      </p>

      {snapshot.groups.length > 0 && (
        <>
          <div className="split" aria-hidden="true">
            {snapshot.groups.map((group, index) => (
              <i key={group.name} style={{ width: `${group.pct}%`, background: SPLIT_SHADES[Math.min(index, SPLIT_SHADES.length - 1)] }} />
            ))}
          </div>
          <ul className="split-list">
            {snapshot.groups.map((group, index) => (
              <li key={group.name}><span><i style={{ background: SPLIT_SHADES[Math.min(index, SPLIT_SHADES.length - 1)] }} />{group.name}</span><b className="num">{group.count}</b></li>
            ))}
          </ul>
        </>
      )}

      {joiners.length > 0 && (
        <div className="joined">
          <h3>{snapshot.joiners.length ? "Recently joined" : "Latest to join"}</h3>
          {joiners.map((entry) => (
            <div key={entry.employee.id} className="joined__row">
              <PersonCell emp={entry.employee} sub={entry.employee.pos} size={32} />
              <small>{formatDay(entry.joinedOn)}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// ---- Performance ----

export const PerformanceCard = ({ snapshot, awaiting, navigate }) => (
  <section className="card dash-perf" aria-labelledby="perfTitle">
    <div className="sh"><h2 id="perfTitle">Performance</h2><span>team average</span></div>
    {snapshot.average === null ? (
      <div className="figure figure--quiet">Not rated yet</div>
    ) : (
      <div className="figure"><CountUp value={String(snapshot.average)} as="span" /><span className="figure__of"> / 10</span></div>
    )}
    <p className="sub">{snapshot.people.length ? `${snapshot.peopleRated} of ${snapshot.people.length} ${snapshot.people.length === 1 ? "person" : "people"} rated` : "No KPIs have been assigned yet"}</p>

    {snapshot.people.length > 0 && (
      <ul className="dots" aria-label="Each person's rating, strongest first">
        {snapshot.people.map((row) => (
          <li key={row.employee.id} className={"dots__dot" + (row.rating === null ? " dots__dot--none" : row.rating >= 8 ? "" : row.rating >= 6 ? " dots__dot--mid" : " dots__dot--low")}
            title={`${row.employee.name}: ${row.rating === null ? "not rated" : `${row.rating} of 10`}`} />
        ))}
      </ul>
    )}

    {awaiting.length > 0 && (
      <div className="awaiting">
        <h3>Waiting to be rated</h3>
        {awaiting.slice(0, 3).map((row) => (
          <div key={row.employee.id} className="awaiting__row"><Avatar emp={row.employee} size={28} /><span>{row.employee.name}</span><small>{row.unrated} {row.unrated === 1 ? "KPI" : "KPIs"}</small></div>
        ))}
        <Btn sm variant="ghost" onClick={() => navigate("kpi")}>Open KPIs</Btn>
      </div>
    )}
  </section>
);
