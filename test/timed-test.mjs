import * as nodeTest from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

export * from 'node:test';

/**
 * node:test with test timeouts that do not count time spent waiting for shared test resources, such as a daemon slot.
 * The unit test loader gives test files this module for 'node:test'. Each test gets its own clock; pauseTestClock()
 * stops the clock of the test that calls it until the returned function is called.
 */
const clocks = new AsyncLocalStorage();
const defaultTimeout = Number(process.env.PIOP_TEST_TIMEOUT_MS ?? 30000);
/** The largest timer delay; node:test treats Infinity as "use the default timeout", so this turns its own timeout off. */
const NO_NODE_TIMEOUT = 2 ** 31 - 1;

class TestClock {
  constructor(limit, expire) { this.limit = limit; this.remaining = limit; this.waited = 0; this.pauses = 0; this.expire = expire; this.start(); }
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

/** Stops the current test's timeout clock. Call the returned function to start it again. Outside a test it does nothing. */
export function pauseTestClock() {
  const clock = clocks.getStore();
  if (!clock) return () => {};
  clock.pause();
  let resumed = false;
  return () => { if (!resumed) { resumed = true; clock.resume(); } };
}

function runTimed(limit, run) {
  return new Promise((resolve, reject) => {
    const clock = new TestClock(limit, expired => reject(new Error(`test timed out after ${expired.limit}ms${expired.waited ? ` (not counting ${Math.round(expired.waited)}ms waiting for test resources)` : ''}`)));
    clocks.run(clock, () => { Promise.resolve().then(run).then(resolve, reject).finally(() => clock.stop()); });
  });
}

/** The arguments of a test call, with its function run on a pausable clock and node's own timeout turned off. */
function timed(args) {
  const fnIndex = args.findLastIndex(arg => typeof arg === 'function');
  if (fnIndex < 0) return args;
  const fn = args[fnIndex];
  const optionsIndex = args.findIndex(arg => arg !== null && typeof arg === 'object');
  const options = optionsIndex >= 0 ? args[optionsIndex] : {};
  const limit = options.timeout ?? defaultTimeout;
  const wrapped = function (...testArgs) { return runTimed(limit, () => fn.apply(this, testArgs)); };
  const name = typeof args[0] === 'string' ? [args[0]] : [];
  return [...name, { ...options, timeout: NO_NODE_TIMEOUT }, wrapped];
}

function wrap(base) {
  const wrapped = (...args) => base(...timed(args));
  for (const key of ['skip', 'todo', 'only']) wrapped[key] = (...args) => base[key](...timed(args));
  return wrapped;
}

export const test = wrap(nodeTest.test);
export const it = wrap(nodeTest.it);
export default test;
