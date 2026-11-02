import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => { daemon = await startDaemon(); }, 60_000);
afterAll(() => daemon?.stop(), 60_000);

const RECENT = '__pi-desktop-ungrouped__';
const change = (value: unknown) => daemon.invoke('change_session_groups', { change: value });
const order = (scope: string, owner: string, visible: string[], token: string | null, before: string | null) => ({ type: 'order', scope, owner, visible, token, before });
function publicSession(): string {
  return 'local:' + JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home: daemon.home, cwd: daemon.home, folder: 'order', content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Order test chat', timestamp: 1 } }) + '\n' }),
  })).id;
}
async function create(name: string): Promise<string> {
  const state = await change({ type: 'create', name });
  return state.groups.find((group: { name: string }) => group.name === name).id;
}

test('sidebar order is shared with other clients and drops removed groups', async () => {
  const other = await daemon.connect();
  const [a, b] = [publicSession(), publicSession()];
  await daemon.invoke('load_session_groups', { seeds: [] });
  const alpha = await create('Alpha');
  const beta = await create('Beta');
  expect((await daemon.invoke('load_session_groups', { seeds: [] })).orders.sidebar).toEqual([`group:${beta}`, `group:${alpha}`]);

  const moved = await change({ type: 'batch', changes: [
    order('sidebar', '', [`group:${beta}`, `group:${alpha}`, `group:${RECENT}`], `group:${beta}`, `group:${RECENT}`),
    order('children', alpha, [`session:${a}`], `group:${beta}`, null),
    order('sessions', RECENT, [b, a], a, b),
  ] });
  expect(moved.orders).toEqual({ sidebar: [`group:${alpha}`, `group:${beta}`, `group:${RECENT}`], sessions: { [RECENT]: [a, b] }, children: { [alpha]: [`session:${a}`, `group:${beta}`] } });
  expect(await other.waitEvent('pi://groups-changed', payload => payload.orders.children[alpha] !== undefined)).toEqual(moved);

  const start = other.events.length;
  expect(await change(order('sessions', RECENT, [a, b], null, null))).toEqual(moved);
  const gamma = await create('Gamma');
  await other.waitEvent('pi://groups-changed', payload => payload.groups.some((group: { id: string }) => group.id === gamma));
  expect(other.events.slice(start).filter(event => event.event === 'pi://groups-changed')).toHaveLength(1);

  const removed = await change({ type: 'remove', id: beta });
  expect(removed.orders).toEqual({ sidebar: [`group:${gamma}`, `group:${alpha}`, `group:${RECENT}`], sessions: { [RECENT]: [a, b] }, children: { [alpha]: [`session:${a}`] } });
}, 60_000);

test('a failed change in a batch saves none of the batch', async () => {
  const before = await daemon.invoke('load_session_groups', { seeds: [] });
  const group = before.groups[0].id;
  expect(await daemon.failure('change_session_groups', { change: { type: 'batch', changes: [
    order('children', group, ['session:local:x'], 'session:local:y', null),
    { type: 'rename', id: 'missing', name: 'Missing' },
  ] } })).toBe('Group no longer exists');
  expect(await daemon.invoke('load_session_groups', { seeds: [] })).toEqual(before);
  expect(await daemon.failure('change_session_groups', { change: order('children', 'missing', [], 'session:local:x', null) })).toBe('Group no longer exists');
}, 60_000);
