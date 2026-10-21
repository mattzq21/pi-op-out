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

test('task_end only runs for a normal final response, and preserves the context', async () => {
  const f = fixture();
  hooksExtended(f.pi);
  const seen: any[] = [];
  extendedHooks(f.pi).on('task_end', (event, ctx) => { seen.push({ event, ctx }); });
  for (const reason of ['toolUse', 'error', 'aborted', 'length']) await f.emit('turn_end', end(reason));
  await f.emit('turn_end', end('stop', [{ type: 'toolCall', name: 'bash' }]));
  await f.emit('turn_end', { ...end(), message: { role: 'user', content: 'Hello' } });
  expect(seen).toEqual([]);
  await f.emit('turn_end', end());
  expect(seen).toEqual([{ event: { ...end(), type: 'task_end' }, ctx: f.ctx }]);
});

test('task_end waits for handlers in order before the next task can run', async () => {
  const f = fixture();
  hooksExtended(f.pi);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const hooks = extendedHooks(f.pi);
  hooks.on('task_end', async () => { order.push('saving'); await held; order.push('saved'); });
  hooks.on('task_end', () => { order.push('second handler'); });
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
  const off = extendedHooks(f.pi).on('task_end', async () => { throw new Error('Save failed'); });
  await expect(f.emit('turn_end', end())).rejects.toThrow('Save failed');
  off();
  await f.emit('turn_end', end());
  extendedHooks(f.pi).on('task_end', () => { throw new Error('Stale handler'); });
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
