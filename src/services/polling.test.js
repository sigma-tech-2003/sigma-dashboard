import assert from "node:assert/strict";
import test from "node:test";
import { POLL_INTERVAL_MS, POLL_MAX_BACKOFF_MS } from "../config/polling.js";
import { createPollingHub } from "./polling.js";

// A fake clock: timers fire in time order as `advance` moves time forward, and each firing is followed by a
// real macrotask turn so the async work it starts can settle.
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].callback();
        await settle();
      }
      time = target;
      await settle();
    },
    settle,
  };
}

function fakeVisibility() {
  let hidden = false;
  const listeners = new Set();
  return {
    isHidden: () => hidden,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { hidden = value; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
}

function setup(options = {}) {
  const clock = fakeClock();
  const visibility = fakeVisibility();
  const hub = createPollingHub({ intervalMs: 1000, maxBackoffMs: 8000, ...clock, visibility, ...options });
  return { clock, visibility, hub };
}

const source = (results) => {
  const calls = { count: 0 };
  return {
    calls,
    fetch: async () => {
      const result = results[Math.min(calls.count, results.length - 1)];
      calls.count += 1;
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result() : result;
    },
  };
};

const sink = () => {
  const received = { data: [], errors: [] };
  return { received, onData: (data) => received.data.push(data), onError: (error) => received.errors.push(error) };
};

test("the default cadence is 30 seconds with a 5 minute backoff cap", () => {
  assert.equal(POLL_INTERVAL_MS, 30_000);
  assert.equal(POLL_MAX_BACKOFF_MS, 300_000);
});

test("the first fetch runs immediately, then once per interval", async () => {
  const { clock, hub } = setup();
  const feed = source([[1], [2], [3], [4]]);
  const out = sink();
  hub.register({ fetch: feed.fetch, ...out });

  await clock.advance(0);
  assert.equal(feed.calls.count, 1);
  await clock.advance(999);
  assert.equal(feed.calls.count, 1, "not before the interval");
  await clock.advance(1);
  assert.equal(feed.calls.count, 2);
  await clock.advance(1000);
  assert.equal(feed.calls.count, 3);
  assert.deepEqual(out.received.data, [[1], [2], [3]]);
});

test("many registrations share ONE timer", async () => {
  const { clock, hub } = setup();
  for (let i = 0; i < 8; i += 1) hub.register({ fetch: source([[i]]).fetch, ...sink() });

  assert.equal(clock.pending(), 1);
  await clock.advance(0);
  assert.equal(clock.pending(), 1, "still one, after they all ran");
  assert.equal(hub.size(), 8);
});

test("a slow response never overlaps the next poll", async () => {
  const { clock, hub } = setup();
  let running = 0;
  let maxRunning = 0;
  const slow = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return [1];
  };
  hub.register({ fetch: slow, ...sink() });

  await clock.advance(5000);
  assert.equal(maxRunning, 1);
});

test("a poll that returns the same data does not call onData again", async () => {
  const { clock, hub } = setup();
  const out = sink();
  hub.register({ fetch: source([[{ id: 1 }], [{ id: 1 }], [{ id: 1 }], [{ id: 2 }]]).fetch, ...out });

  await clock.advance(3000);
  assert.deepEqual(out.received.data, [[{ id: 1 }], [{ id: 2 }]]);
});

test("a tab that is hidden is not polled, and nothing is scheduled", async () => {
  const { clock, hub, visibility } = setup();
  const feed = source([[1]]);
  hub.register({ fetch: feed.fetch, ...sink() });
  await clock.advance(0);
  assert.equal(feed.calls.count, 1);

  visibility.set(true);
  assert.equal(clock.pending(), 0, "no timer while hidden");
  await clock.advance(60_000);
  assert.equal(feed.calls.count, 1, "no polls while hidden");
});

test("becoming visible again polls straight away if the data went stale, and resumes the cadence", async () => {
  const { clock, hub, visibility } = setup();
  const feed = source([[1], [2], [3], [4]]);
  const out = sink();
  hub.register({ fetch: feed.fetch, ...out });
  await clock.advance(0);

  visibility.set(true);
  await clock.advance(60_000);
  visibility.set(false);
  await clock.advance(0);
  assert.equal(feed.calls.count, 2, "one catch-up poll on return, not one per missed interval");

  await clock.advance(1000);
  assert.equal(feed.calls.count, 3, "and the normal cadence is back");
});

test("becoming visible does not poll early if the data is still fresh", async () => {
  const { clock, hub, visibility } = setup();
  const feed = source([[1], [2]]);
  hub.register({ fetch: feed.fetch, ...sink() });
  await clock.advance(0);

  visibility.set(true);
  await clock.advance(200);
  visibility.set(false);
  await clock.advance(0);

  assert.equal(feed.calls.count, 1);
});

test("a failed poll reports the error, keeps going, and backs off exponentially up to the cap", async () => {
  const { clock, hub } = setup();
  const feed = source([new Error("down")]);
  const out = sink();
  hub.register({ fetch: feed.fetch, ...out });

  await clock.advance(0);
  assert.equal(feed.calls.count, 1);
  assert.equal(out.received.errors.length, 1);

  await clock.advance(1999);
  assert.equal(feed.calls.count, 1, "backoff 2x the interval after the first failure");
  await clock.advance(1);
  assert.equal(feed.calls.count, 2);

  await clock.advance(3999);
  assert.equal(feed.calls.count, 2, "4x after the second");
  await clock.advance(1);
  assert.equal(feed.calls.count, 3);

  await clock.advance(8000);
  await clock.advance(8000);
  assert.equal(feed.calls.count, 5, "capped at maxBackoffMs, not 16x or 32x");
});

test("a successful poll after failures resets the backoff and clears the error even if the data is unchanged", async () => {
  const { clock, hub } = setup();
  const feed = source([[1], new Error("blip"), [1], [1]]);
  const out = sink();
  hub.register({ fetch: feed.fetch, ...out });

  await clock.advance(0);
  await clock.advance(1000);
  assert.equal(out.received.errors.length, 1);
  await clock.advance(2000);

  assert.deepEqual(out.received.data, [[1], [1]], "onData fires after recovery so the hook can clear its error");
  await clock.advance(1000);
  assert.equal(feed.calls.count, 4, "the normal interval is back");
});

test("stop() ends polling, drops a late result, and frees the timer and the visibility listener", async () => {
  const { clock, hub, visibility } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const out = sink();
  const registration = hub.register({ fetch: () => gate, ...out });
  await clock.advance(0);

  registration.stop();
  release([1]);
  await clock.settle();

  assert.deepEqual(out.received.data, [], "the late result is dropped");
  assert.equal(clock.pending(), 0);
  assert.equal(visibility.listenerCount(), 0);
  assert.equal(hub.size(), 0);
});

test("stopping one registration leaves the others polling", async () => {
  const { clock, hub } = setup();
  const a = source([[1]]);
  const b = source([[2]]);
  const first = hub.register({ fetch: a.fetch, ...sink() });
  hub.register({ fetch: b.fetch, ...sink() });
  await clock.advance(0);

  first.stop();
  await clock.advance(3000);

  assert.equal(a.calls.count, 1);
  assert.equal(b.calls.count, 4);
});

test("pollNow() fetches immediately, and the cadence continues from there", async () => {
  const { clock, hub } = setup();
  const feed = source([[1], [2], [3]]);
  const out = sink();
  const registration = hub.register({ fetch: feed.fetch, ...out });
  await clock.advance(0);

  await clock.advance(300);
  await registration.pollNow();

  assert.equal(feed.calls.count, 2);
  assert.deepEqual(out.received.data, [[1], [2]]);
  await clock.advance(999);
  assert.equal(feed.calls.count, 2, "the next poll is a full interval after the forced one");
});

test("pollNow() during a poll already in flight triggers a second fetch, not a stale result", async () => {
  const { clock, hub } = setup();
  const resolvers = [];
  const out = sink();
  let calls = 0;
  const registration = hub.register({
    fetch: () => new Promise((resolve) => { calls += 1; resolvers.push(resolve); }),
    ...out,
  });
  await clock.advance(0);
  assert.equal(calls, 1);

  await registration.pollNow();
  resolvers[0](["before-the-write"]);
  await clock.settle();
  assert.equal(calls, 2, "a fresh fetch started once the first finished");

  resolvers[1](["after-the-write"]);
  await clock.settle();
  assert.deepEqual(out.received.data.at(-1), ["after-the-write"]);
});

test("pollNow() while the tab is hidden waits for it to become visible", async () => {
  const { clock, hub, visibility } = setup();
  const feed = source([[1], [2]]);
  const registration = hub.register({ fetch: feed.fetch, ...sink() });
  await clock.advance(0);

  visibility.set(true);
  await registration.pollNow();
  assert.equal(feed.calls.count, 1);

  visibility.set(false);
  await clock.advance(0);
  assert.equal(feed.calls.count, 2);
});

test("one registration failing does not stop the others in the same tick", async () => {
  const { clock, hub } = setup();
  const good = source([[1], [2]]);
  const outGood = sink();
  hub.register({ fetch: source([new Error("x")]).fetch, ...sink() });
  hub.register({ fetch: good.fetch, ...outGood });

  await clock.advance(1000);

  assert.ok(outGood.received.data.length >= 2);
});

test("a tab opened while HIDDEN still makes its first fetch, then does not poll until it is visible", async () => {
  const { clock, hub, visibility } = setup();
  visibility.set(true);
  const feed = source([[1], [2]]);
  const out = sink();

  hub.register({ fetch: feed.fetch, ...out });
  await clock.advance(0);

  assert.equal(feed.calls.count, 1, "the initial load is not a poll");
  assert.deepEqual(out.received.data, [[1]]);
  await clock.advance(60_000);
  assert.equal(feed.calls.count, 1, "but nothing follows while hidden");

  visibility.set(false);
  await clock.advance(0);
  assert.equal(feed.calls.count, 2, "and the stale data is refreshed on becoming visible");
});

test("pollAllNow() polls every registration at once (for a write made outside the data hooks)", async () => {
  const { clock, hub } = setup();
  const a = source([[1], [2]]);
  const b = source([[10], [20]]);
  hub.register({ fetch: a.fetch, ...sink() });
  hub.register({ fetch: b.fetch, ...sink() });
  await clock.advance(0);

  await hub.pollAllNow();

  assert.equal(a.calls.count, 2);
  assert.equal(b.calls.count, 2);
});

test("pollAllNow() with nothing registered is a no-op", async () => {
  const { hub } = setup();
  await hub.pollAllNow();
});
