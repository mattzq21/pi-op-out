import * as bunTest from 'bun:test';
import { defaultTimeout, NO_RUNNER_TIMEOUT, runTimed } from '../test-clock.mjs';

/**
 * Preloaded by scripts/test-daemon.mjs: bun:test with test timeouts that do not count waits for shared test
 * resources (see test/test-clock.mjs). test and test.concurrent run each test function on its own clock;
 * hooks and other test forms keep bun's own timeout.
 */
const original = { ...bunTest };

function timed(args: any[]): any[] {
  const [name, fn, limitOrOptions] = args;
  // A test that takes a done callback ends by the callback, not its result, so it keeps bun's own timeout.
  if (typeof fn !== 'function' || fn.length > 0) return args;
  const options = typeof limitOrOptions === 'object' && limitOrOptions !== null ? limitOrOptions : {};
  const limit = typeof limitOrOptions === 'number' ? limitOrOptions : options.timeout ?? defaultTimeout;
  const wrapped = function (this: unknown) { return runTimed(limit, () => fn.call(this)); };
  return [name, wrapped, typeof limitOrOptions === 'object' && limitOrOptions !== null ? { ...options, timeout: NO_RUNNER_TIMEOUT } : NO_RUNNER_TIMEOUT];
}

function wrap(base: any) {
  const wrapped: any = Object.assign((...args: any[]) => base(...timed(args)), base);
  wrapped.concurrent = Object.assign((...args: any[]) => base.concurrent(...timed(args)), base.concurrent);
  return wrapped;
}

const test = wrap(original.test);
bunTest.mock.module('bun:test', () => ({ ...original, test, it: test }));
