import { CalendarCheck } from "lucide-react";
import Avatar from "../../../components/avatar/Avatar";
import EmptyState from "../../../components/empty-state/EmptyState";
import { formatRange } from "../dashboardData";

const labelFor = (bar) => (bar.end > bar.start ? bar.type.split(" ")[0] : bar.type[0]);

// A fortnight at a glance: a row for each person who is away, a bar for each leave. Solid is approved, dashed is still
// waiting for a decision, so deciding in "Needs you" visibly changes the bar here.
const AwayCalendar = ({ calendar }) => {
  const { columns, rows, hasAny } = calendar;
  const range = formatRange(columns[0].iso, columns[columns.length - 1].iso);

  return (
    <section className="card dash-away" aria-labelledby="awayTitle">
      <div className="sh"><h2 id="awayTitle">Who is away, next two weeks</h2><span>{range}</span></div>

      {!hasAny ? (
        <EmptyState icon={CalendarCheck} title="Nobody is away" description="Approved and waiting leave for the next two weeks will show here." />
      ) : (
        <>
          <div className="away-scroll">
            <div className="away" style={{ "--cols": columns.length }} role="table" aria-label="Leave calendar">
              <div className="away__corner" />
              {columns.map((day) => (
                <div key={day.iso} className={"away__head" + (day.weekend ? " away__head--we" : "") + (day.today ? " away__head--today" : "")}>
                  <b>{day.n}</b>{day.weekday}
                </div>
              ))}
              {rows.map((row, index) => (
                <div key={row.employee.id} className="away__row" role="row" style={{ "--row": index + 2 }}>
                  <div className="away__name"><Avatar emp={row.employee} size={26} /><span>{row.employee.name}</span></div>
                  {columns.map((day, dayIndex) => <div key={day.iso} className={"away__cell" + (day.weekend ? " away__cell--we" : "")} style={{ gridColumn: dayIndex + 2 }} />)}
                  {row.bars.map((bar, barIndex) => (
                    <div
                      key={bar.id}
                      className={`away__bar away__bar--${bar.status}`}
                      style={{ gridColumn: `${bar.start + 2} / ${bar.end + 3}`, "--i": index + barIndex }}
                      title={`${row.employee.name} · ${bar.type} · ${formatRange(bar.from, bar.to)}${bar.status === "pending" ? " · waiting for a decision" : ""}`}
                    >
                      {labelFor(bar)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="legend">
            <span><i className="legend__sw legend__sw--ok" />Approved</span>
            <span><i className="legend__sw legend__sw--pending" />Waiting for a decision</span>
          </div>
        </>
      )}
    </section>
  );
};

export default AwayCalendar;
