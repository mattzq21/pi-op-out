import { expect, test } from 'bun:test';
import hooksExtended from '../../daemon/resources/hooks-extended/index.ts';
import { extendedHooks } from '../../daemon/resources/hooks-extended/interface.ts';

function fixture() {
  const native = new Map<string, Function[]>();
  const bus = new Map<string, Set<Function>>();
  const pi: any = {
    on(name: string, handler: Function) {
      native.set(name, [...(native.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Function) {
        if (!bus.has(name)) bus.set(name, new Set());
        bus.get(name)!.add(handler);
        return () => bus.get(name)!.delete(handler);
      },
      emit(name: string, data: unknown) { for (const handler of bus.get(name) ?? []) handler(data); },
    },
  };
  const ctx: any = { cwd: '/test' };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of native.get(name) ?? []) await handler(event, ctx);
  };
  return { pi, ctx, emit };
}
const end = (stopReason = 'stop', content: any[] = [{ type: 'text', text: 'Done' }]) => ({
  type: 'turn_end', turnIndex: 3, message: { role: 'assistant', stopReason, content }, toolResults: [],
});

test('task_success only runs for a normal final response, and preserves the context', async () => {
  const f = fixture();
  hooksExtended(f.pi);
  const seen: any[] = [];
  extendedHooks(f.pi).on('task_success', (event, ctx) => { seen.push({ event, ctx }); });
  for (const reason of ['toolUse', 'error', 'aborted', 'length']) await f.emit('turn_end', end(reason));
  await f.emit('turn_end', end('stop', [{ type: 'toolCall', name: 'bash' }]));
  await f.emit('turn_end', { ...end(), message: { role: 'user', content: 'Hello' } });
  expect(seen).toEqual([]);
  await f.emit('turn_end', end());
  expect(seen).toEqual([{ event: { ...end(), type: 'task_success' }, ctx: f.ctx }]);
});

test('task_success waits for handlers in order before the next task can run', async () => {
  const f = fixture();
  hooksExtended(f.pi);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const hooks = extendedHooks(f.pi);
  hooks.on('task_success', async () => { order.push('saving'); await held; order.push('saved'); });
  hooks.on('task_success', () => { order.push('second handler'); });
  const run = f.emit('turn_end', end()).then(() => { order.push('next task'); });
  expect(order).toEqual(['saving']);
  release();
  await run;
  expect(order).toEqual(['saving', 'saved', 'second handler', 'next task']);
});

test('handler failures reach Pi and subscriptions are removed on shutdown', async () => {
  const f = fixture();
  expect(() => extendedHooks(f.pi)).toThrow('Load hooks-extended');
  hooksExtended(f.pi);
  const off = extendedHooks(f.pi).on('task_success', async () => { throw new Error('Save failed'); });
  await expect(f.emit('turn_end', end())).rejects.toThrow('Save failed');
  off();
  await f.emit('turn_end', end());
  extendedHooks(f.pi).on('task_success', () => { throw new Error('Stale handler'); });
  await f.emit('session_shutdown');
  await f.emit('turn_end', end());
  expect(() => extendedHooks(f.pi)).toThrow('Load hooks-extended');
});

for (const [native, reason] of [['session_start', 'start'], ['session_tree', 'branch_change']] as const) {
  test(`session_restore waits for restoration on ${reason} and passes the current context`, async () => {
    const f = fixture();
    hooksExtended(f.pi);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen: unknown[] = [];
    const off = extendedHooks(f.pi).on('session_restore', async (event, ctx) => {
      seen.push(event, ctx);
      await held;
      seen.push('restored');
    });
    const run = f.emit(native).then(() => { seen.push('continued'); });
    await Promise.resolve();
    expect(seen).toEqual([{ type: 'session_restore', reason }, f.ctx]);
    release();
    await run;
    expect(seen.slice(2)).toEqual(['restored', 'continued']);
    off();
    seen.length = 0;
    await f.emit(native);
    expect(seen).toEqual([]);
    extendedHooks(f.pi).on('session_restore', async () => { throw new Error('Restore failed'); });
    await expect(f.emit(native)).rejects.toThrow('Restore failed');
    await f.emit('session_shutdown');
    await f.emit(native);
  });
}

function busyFixture() {
  const f = fixture();
  let idle = false;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const errors: string[] = [];
  f.ctx.isIdle = () => idle;
  f.ctx.ui = { notify: (message: string) => errors.push(message) };
  f.ctx[Symbol.for('piop.wait-for-idle')] = () => ready;
  hooksExtended(f.pi);
  return { ...f, errors, finish: () => { idle = true; release(); } };
}

for (const event of ['agent_start', 'session_before_compact', 'session_before_tree']) {
  test(`session_available waits outside ${event}, including cancellation without an end event`, async () => {
    const f = busyFixture();
    let notify!: () => void;
    const notified = new Promise<void>(resolve => { notify = resolve; });
    const seen: unknown[] = [];
    extendedHooks(f.pi).on('session_available', (event, ctx) => { seen.push(event, ctx.isIdle()); notify(); });
    await f.emit(event);
    expect(seen).toEqual([]);
    // Multiple overlapping operations share one notification.
    await f.emit('session_before_compact');
    f.finish();
    await notified;
    expect(seen).toEqual([{ type: 'session_available' }, true]);
    expect(f.errors).toEqual([]);
  });
}

test('availability waits are cancelled on shutdown and never notify a closed session', async () => {
  const f = busyFixture();
  const seen: unknown[] = [];
  extendedHooks(f.pi).on('session_available', event => { seen.push(event); });
  await f.emit('agent_start');
  const wait = extendedHooks(f.pi).waitForAvailable(f.ctx);
  const rejected = wait.then(() => undefined, error => error);
  await f.emit('session_shutdown');
  expect((await rejected)?.message).toContain("Session ended");
  f.finish();
  await Promise.resolve();
  expect(seen).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('availability errors are reported, and an already available session needs no wait', async () => {
  const f = busyFixture();
  f.ctx[Symbol.for('piop.wait-for-idle')] = () => Promise.reject(new Error('Wait failed'));
  await expect(extendedHooks(f.pi).waitForAvailable(f.ctx)).rejects.toThrow('Wait failed');
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  f.ctx.ui.notify = (message: string) => { f.errors.push(message); notify(); };
  await f.emit('agent_start');
  await notified;
  expect(f.errors).toEqual(['Session availability failed: Wait failed']);
  f.finish();
  await extendedHooks(f.pi).waitForAvailable(f.ctx);
});

test('runtime invalidation cancels availability before the context becomes stale', async () => {
  const { installAvailability } = await import('../../daemon/resources/runtime-availability.cjs');
  const f = fixture();
  let idle = false;
  let stale = false;
  let staleReads = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const check = () => { if (stale) { staleReads++; throw new Error('Stale context'); } };
  const runner = {
    createContext() { return { isIdle: () => { check(); return idle; }, get ui() { check(); return { notify() {} }; } }; },
    invalidate() { stale = true; },
  };
  class Session {
    _bindExtensionCore(_runner: typeof runner) {}
    waitForIdle() { return ready; }
  }
  installAvailability(Session);
  new Session()._bindExtensionCore(runner);
  Object.defineProperties(f.ctx, Object.getOwnPropertyDescriptors(runner.createContext()));
  hooksExtended(f.pi);
  const seen: unknown[] = [];
  extendedHooks(f.pi).on('session_available', event => { seen.push(event); });
  await f.emit('agent_start');
  const pending = extendedHooks(f.pi).waitForAvailable(f.ctx).catch(error => error);
  idle = true;
  release();
  runner.invalidate();
  expect(await pending).toBeInstanceOf(Error);
  await new Promise(resolve => setImmediate(resolve));
  expect(staleReads).toBe(0);
  expect(seen).toEqual([]);
});

for (const fails of [false, true]) test(`invalidation during an availability handler skips remaining handlers and stale errors (rejects: ${fails})`, async () => {
  const f = busyFixture();
  const lifetime = new AbortController();
  f.ctx[Symbol.for('piop.context-lifetime')] = lifetime.signal;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let finish!: () => void;
  const held = new Promise<void>((resolve, reject) => { finish = () => fails ? reject(new Error('Handler stopped')) : resolve(); });
  let laterCalls = 0;
  const hooks = extendedHooks(f.pi);
  hooks.on('session_available', async () => { began(); await held; });
  hooks.on('session_available', () => { laterCalls++; });
  await f.emit('agent_start');
  f.finish();
  await started;
  lifetime.abort();
  Object.defineProperty(f.ctx, 'ui', { get() { throw new Error('Stale context'); } });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  expect(laterCalls).toBe(0);
  expect(f.errors).toEqual([]);
});
