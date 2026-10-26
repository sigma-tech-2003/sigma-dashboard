import { useEffect } from "react";
import { AlertCircle, Banknote, Check } from "lucide-react";
import Avatar from "../../../components/avatar/Avatar";
import Btn from "../../../components/btn/Btn";
import FormFeedback from "../../../components/form-feedback/FormFeedback";
import { usePresenceList } from "../../../hooks/usePresenceList";
import { useReducedMotion } from "../../../hooks/useReducedMotion";
import { formatRange, waitingLabel } from "../dashboardData";

const EXIT_MS = 260;

// One row. When its item leaves the data it collapses (CSS, 200 ms) and then asks to be removed.
const NeedRow = ({ entry, onExited, children }) => {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!entry.exiting) return undefined;
    if (reduced) {
      onExited(entry.key);
      return undefined;
    }
    const timer = setTimeout(() => onExited(entry.key), EXIT_MS + 60);
    return () => clearTimeout(timer);
  }, [entry.exiting, entry.key, onExited, reduced]);

  return <li className={"need-item" + (entry.exiting ? " need-item--leaving" : "")}>{children}</li>;
};

const LeaveBody = ({ item, busy, onDecide }) => (
  <>
    <Avatar emp={item.employee} size={40} />
    <div className="need-item__body">
      <div className="need-item__title">
        <b>{item.employee.name}</b>
        <span className="chip chip--warn">{item.type}</span>
        <span className="chip">{item.days} {item.days === 1 ? "day" : "days"}</span>
      </div>
      <div className="need-item__note">{formatRange(item.from, item.to)}{item.reason ? ` · ${item.reason}` : ""}</div>
      <div className="need-item__when">{waitingLabel(item.waitDays)}{item.employee.pos ? ` · ${item.employee.pos}` : ""}</div>
    </div>
    <div className="need-item__actions">
      <Btn variant="ghost" onClick={() => onDecide(item, false)} disabled={busy} aria-label={`Decline ${item.employee.name}'s leave`}>Decline</Btn>
      <Btn onClick={() => onDecide(item, true)} disabled={busy} aria-label={`Approve ${item.employee.name}'s leave`}>
        {busy ? "Saving…" : <><Check size={16} aria-hidden="true" />Approve</>}
      </Btn>
    </div>
  </>
);

const NoteBody = ({ icon: Icon, tone, title, note, chip, action, onAction }) => (
  <>
    <span className={`need-icon need-icon--${tone}`} aria-hidden="true"><Icon size={18} /></span>
    <div className="need-item__body">
      <div className="need-item__title"><b>{title}</b>{chip && <span className={`chip chip--${tone}`}>{chip}</span>}</div>
      <div className="need-item__note">{note}</div>
    </div>
    <div className="need-item__actions"><Btn variant="ghost" onClick={onAction}>{action}</Btn></div>
  </>
);

// The decisions and loose ends waiting for this person, most pressing first. Approving or declining a leave request
// plays out in the row: it collapses away once the server has confirmed, and the calendar below updates with it.
const NeedsYou = ({ items, busyKey, error, onDecide, onApproveAll, navigate }) => {
  const { entries, remove } = usePresenceList(items, (item) => item.key);
  const live = entries.filter((entry) => !entry.exiting);
  const leaveCount = live.filter((entry) => entry.item.kind === "leave").length;

  return (
    <section className="card dash-need" aria-labelledby="needTitle">
      <div className="sh">
        <h2 id="needTitle">Needs you</h2>
        <div className="sh__side">
          {leaveCount > 1 && <Btn sm variant="ghost" onClick={onApproveAll} disabled={Boolean(busyKey)}>Approve all {leaveCount}</Btn>}
          <span>{live.length} {live.length === 1 ? "item" : "items"}</span>
        </div>
      </div>

      <FormFeedback>{error}</FormFeedback>

      <ul className="need-list">
        {entries.map((entry) => (
          <NeedRow key={entry.key} entry={entry} onExited={remove}>
            {entry.item.kind === "leave" && <LeaveBody item={entry.item} busy={busyKey === entry.key} onDecide={onDecide} />}
            {entry.item.kind === "review" && (
              <NoteBody icon={AlertCircle} tone="bad" title={entry.item.title} note={entry.item.note} chip="Waiting" action="Open KPIs" onAction={() => navigate("kpi")} />
            )}
            {entry.item.kind === "payroll" && (
              <NoteBody icon={Banknote} tone="warn" title={entry.item.title} note={entry.item.note} chip={entry.item.chip} action="Open payroll" onAction={() => navigate("payroll")} />
            )}
          </NeedRow>
        ))}
      </ul>

      {live.length === 0 && (
        <div className="need-empty"><b>You are clear.</b>Nothing needs you right now.</div>
      )}
    </section>
  );
};

export default NeedsYou;
