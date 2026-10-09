import { POLL_INTERVAL_MS, POLL_MAX_BACKOFF_MS } from "../config/polling.js";

// The polling hub that replaces Firestore's onSnapshot (D3). One hub, ONE timer, however many collections are
// registered (migration-plan item 4: one polling loop, not eight independent timers).
//
//   - The first fetch of a registration runs immediately; later ones every `intervalMs`.
//   - A setTimeout chain, never setInterval, and a per-registration in-flight guard: a slow response can
//     never overlap the next poll.
//   - Paused while the tab is hidden, except for a registration's first fetch (a tab opened in the background
//     still loads). On becoming visible, anything that came due meanwhile runs at once.
//   - A failed poll backs off (intervalMs * 2^failures, capped) and reports the error WITHOUT discarding the
//     data already shown. The next success clears the error.
//   - A poll that returns exactly what the last one did does not call onData, so the page does not re-render
//     every 30 seconds for nothing.
//   - Late results after stop() are dropped.
//
// Pure JavaScript with injectable clock, timers and visibility so it runs in plain Node under `node --test`.

const browserVisibility = () => ({
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  subscribe(listener) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

export function createPollingHub({
  intervalMs = POLL_INTERVAL_MS,
  maxBackoffMs = POLL_MAX_BACKOFF_MS,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  visibility = browserVisibility(),
} = {}) {
  const entries = new Set();
  let timer = null;
  let unsubscribeVisibility = null;

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (entries.size === 0 || visibility.isHidden()) return;
    const nextDue = Math.min(...[...entries].map((entry) => entry.nextDue));
    timer = setTimer(tick, Math.max(0, nextDue - now()));
  };

  async function runEntry(entry, force = false) {
    if (entry.stopped) return;
    if (entry.inFlight) {
      // A poll requested after a mutation must not be satisfied by a request that began before it.
      if (force) entry.rerun = true;
      return;
    }
    entry.inFlight = true;
    try {
      const data = await entry.fetch();
      if (entry.stopped) return;
      const json = JSON.stringify(data);
      const changed = !entry.hasData || entry.lastError || json !== entry.lastJson;
      entry.failures = 0;
      entry.lastError = false;
      entry.hasData = true;
      entry.lastJson = json;
      entry.nextDue = now() + intervalMs;
      if (changed) entry.onData(data);
    } catch (error) {
      if (entry.stopped) return;
      entry.failures += 1;
      entry.lastError = true;
      entry.nextDue = now() + Math.min(maxBackoffMs, intervalMs * 2 ** entry.failures);
      entry.onError(error);
    } finally {
      entry.inFlight = false;
      if (entry.rerun && !entry.stopped) {
        entry.rerun = false;
        await runEntry(entry);
      }
    }
  }

  async function tick() {
    timer = null;
    if (visibility.isHidden()) return;
    const due = [...entries].filter((entry) => entry.nextDue <= now());
    await Promise.allSettled(due.map(runEntry));
    schedule();
  }

  const onVisibilityChange = () => schedule();

  return Object.freeze({
    /**
     * @param {{ fetch: () => Promise<unknown>, onData: (data: unknown) => void, onError: (error: unknown) => void }} registration
     * @returns {{ stop: () => void, pollNow: () => Promise<void> }}
     */
    register({ fetch, onData, onError }) {
      const entry = {
        fetch, onData, onError,
        nextDue: now(), failures: 0, inFlight: false, rerun: false, stopped: false,
        hasData: false, lastJson: null, lastError: false,
      };
      entries.add(entry);
      if (!unsubscribeVisibility) unsubscribeVisibility = visibility.subscribe(onVisibilityChange);
      // Polling stops while the tab is hidden, but the FIRST load must not: a page opened in a background tab
      // would otherwise sit on its loading screen until someone switched to it.
      if (visibility.isHidden()) runEntry(entry).finally(schedule);
      else schedule();

      return {
        stop() {
          entry.stopped = true;
          entries.delete(entry);
          if (entries.size === 0) {
            clear();
            unsubscribeVisibility?.();
            unsubscribeVisibility = null;
          } else {
            schedule();
          }
        },
        /** Poll this registration now (after a mutation). While the tab is hidden it runs when it becomes visible. */
        async pollNow() {
          entry.nextDue = now();
          if (visibility.isHidden()) return;
          await runEntry(entry, true);
          schedule();
        },
      };
    },
    /**
     * Poll every registration now. For a write made OUTSIDE the data hooks (EmployeesPage calls inviteEmployee
     * directly), which has no hook to re-poll for it. A hidden tab waits until it is visible.
     */
    async pollAllNow() {
      const live = [...entries];
      for (const entry of live) entry.nextDue = now();
      if (!visibility.isHidden()) await Promise.allSettled(live.map((entry) => runEntry(entry, true)));
      schedule();
    },
    /** For tests: how many registrations are live. */
    size: () => entries.size,
  });
}

export const pollingHub = createPollingHub();
