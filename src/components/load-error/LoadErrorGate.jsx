import "./LoadErrorGate.css";
import { useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { pollingHub } from "../../services/polling.js";
import { evaluateLoadErrors, joinLabels } from "../../utils/loadErrors";
import Btn from "../btn/Btn";

// Wraps a page whose data comes from collections that can fail to LOAD. The decision lives in
// utils/loadErrors.js (tested without React); this only renders it.
//
//   blocked  the page body is replaced by an error, because rendering it would show zeros and "no records"
//            for data that is merely missing;
//   stale    the page renders, with a warning above it that the figures may be out of date;
//   ok       the page renders untouched.
//
// `errors` are the hooks' LOAD errors by collection (not write errors, which pages report themselves).
// `required` / `optional` map collection name -> the array the page renders. Retrying re-polls everything now;
// the hub also retries by itself, with backoff, and the gate disappears as soon as a poll succeeds.

const RetryButton = () => {
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    setRetrying(true);
    pollingHub.pollAllNow().catch(() => {}).finally(() => setRetrying(false));
  };

  return (
    <Btn variant="outline" sm onClick={retry} disabled={retrying}>
      <RefreshCw size={13} />{retrying ? "Retrying…" : "Try again"}
    </Btn>
  );
};

const LoadErrorGate = ({ errors, required, optional, children }) => {
  const { status, blocking, stale, messages } = evaluateLoadErrors({ errors, required, optional });

  if (status === "blocked") {
    const labels = joinLabels(blocking.map((item) => item.label));
    return (
      <div className="load-error load-error--blocked" role="alert">
        <TriangleAlert className="load-error__icon" size={32} />
        <div className="load-error__title">We couldn’t load {labels}</div>
        <div className="load-error__description">
          {messages.join(" ")} This is a loading problem. It does not mean there is no data.
        </div>
        <div className="load-error__actions"><RetryButton /></div>
        <div className="load-error__hint">We’ll also keep trying automatically.</div>
      </div>
    );
  }

  if (status === "stale") {
    // Data from an earlier load is out of date; a collection that never loaded leaves related figures missing.
    const outOfDate = stale.filter((item) => item.hasData).map((item) => item.label);
    const missing = stale.filter((item) => !item.hasData).map((item) => item.label);
    return (
      <>
        <div className="load-error load-error--banner" role="alert">
          <TriangleAlert className="load-error__icon" size={18} />
          <div className="load-error__text">
            {outOfDate.length > 0 && (
              <><strong>Couldn’t refresh {joinLabels(outOfDate)}.</strong> What you see may be out of date. </>
            )}
            {missing.length > 0 && (
              <><strong>Couldn’t load {joinLabels(missing)}.</strong> Related figures may be missing or incomplete. </>
            )}
            {messages.join(" ")}
          </div>
          <RetryButton />
        </div>
        {children}
      </>
    );
  }

  return children;
};

export default LoadErrorGate;
