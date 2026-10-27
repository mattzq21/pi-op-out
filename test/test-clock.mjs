import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Test timeouts that do not count time spent waiting for shared test resources, such as daemon slots.
 * The node and bun test wrappers run each test function on its own clock. The clock is also the test's identity
 * for the daemon slots it holds.
 */
const clocks = new AsyncLocalStorage();

/** The default test timeout, from the test runner script. */
export const defaultTimeout = Number(process.env.PIOP_TEST_TIMEOUT_MS ?? 30000);
/** The largest timer delay. Runners treat Infinity as "use the default timeout", so wrappers pass this to turn their own timeout off. */
export const NO_RUNNER_TIMEOUT = 2 ** 31 - 1;

class TestClock {
  constructor(limit, expire) { this.limit = limit; this.remaining = limit; this.waited = 0; this.pauses = 0; this.slots = 0; this.expire = expire; this.start(); }
  start() {
    this.since = performance.now();
    if (Number.isFinite(this.remaining)) this.timer = setTimeout(() => this.expire(this), Math.max(0, this.remaining));
  }
  pause() {
    if (this.pauses++) return;
    clearTimeout(this.timer);
    this.remaining -= performance.now() - this.since;
    this.pausedAt = performance.now();
  }
  resume() {
    if (--this.pauses || this.done) return;
    this.waited += performance.now() - this.pausedAt;
    this.start();
  }
  stop() { this.done = true; clearTimeout(this.timer); }
}

/** The clock of the running test, or undefined outside a wrapped test, for example in a beforeAll hook. */
export function currentTest() { return clocks.getStore(); }

/** Stops the current test's timeout clock. Call the returned function to start it again. Outside a test it does nothing. */
export function pauseTestClock() {
  const clock = clocks.getStore();
  if (!clock) return () => {};
  clock.pause();
  let resumed = false;
  return () => { if (!resumed) { resumed = true; clock.resume(); } };
}

/** Runs a test function on its own clock; rejects when the clock runs out. */
export function runTimed(limit, run) {
  return new Promise((resolve, reject) => {
    const clock = new TestClock(limit, expired => reject(new Error(`test timed out after ${expired.limit}ms${expired.waited ? ` (not counting ${Math.round(expired.waited)}ms waiting for test resources)` : ''}`)));
    clocks.run(clock, () => { Promise.resolve().then(run).then(resolve, reject).finally(() => clock.stop()); });
  });
}
