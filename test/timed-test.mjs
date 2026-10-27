import * as nodeTest from 'node:test';
import { defaultTimeout, NO_RUNNER_TIMEOUT, runTimed } from './test-clock.mjs';

export * from 'node:test';
export { pauseTestClock } from './test-clock.mjs';

/**
 * node:test with test timeouts that do not count waits for shared test resources (see test-clock.mjs).
 * The unit test loader gives test files this module for 'node:test'.
 */
function timed(args) {
  const fnIndex = args.findLastIndex(arg => typeof arg === 'function');
  if (fnIndex < 0) return args;
  const fn = args[fnIndex];
  const optionsIndex = args.findIndex(arg => arg !== null && typeof arg === 'object');
  const options = optionsIndex >= 0 ? args[optionsIndex] : {};
  const limit = options.timeout ?? defaultTimeout;
  const wrapped = function (...testArgs) { return runTimed(limit, () => fn.apply(this, testArgs)); };
  const name = typeof args[0] === 'string' ? [args[0]] : [];
  return [...name, { ...options, timeout: NO_RUNNER_TIMEOUT }, wrapped];
}

function wrap(base) {
  const wrapped = (...args) => base(...timed(args));
  for (const key of ['skip', 'todo', 'only']) wrapped[key] = (...args) => base[key](...timed(args));
  return wrapped;
}

export const test = wrap(nodeTest.test);
export const it = wrap(nodeTest.it);
export default test;
