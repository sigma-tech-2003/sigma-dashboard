// Polling cadence (D3: polling replaces Firestore's onSnapshot). 30 seconds: a decision made by one person
// reaches another within half a minute, while eight collections cost sixteen light requests a minute rather
// than a tight loop. Polling is paused while the tab is hidden (see services/polling.js).
export const POLL_INTERVAL_MS = 30_000;

// After a failed poll the next one waits intervalMs * 2^failures, never longer than this.
export const POLL_MAX_BACKOFF_MS = 5 * 60_000;
