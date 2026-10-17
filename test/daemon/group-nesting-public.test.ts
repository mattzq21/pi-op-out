import { expect, test } from 'bun:test';
import { startDaemon, type TestDaemon } from './harness';

const change = (daemon: TestDaemon, value: unknown) => daemon.invoke('change_session_groups', { change: value });
const load = (daemon: TestDaemon) => daemon.invoke('load_session_groups', { seeds: [] });
async function create(daemon: TestDaemon, name: string): Promise<string> {
  const state = await change(daemon, { type: 'create', name });
  return state.groups.find((group: { name: string }) => group.name === name).id;
}

test('moving a group inside its descendant fails without changing the saved structure', async () => {
  const daemon = await startDaemon();
  try {
    await load(daemon);
    const root = await create(daemon, 'Work');
    const child = await create(daemon, 'Research');
    const leaf = await create(daemon, 'Experiments');
    await change(daemon, { type: 'move', id: child, parent: root });
    await change(daemon, { type: 'move', id: leaf, parent: child });
    const before = await load(daemon);
    expect(before.parents).toEqual({ [child]: root, [leaf]: child });

    expect(await daemon.failure('change_session_groups', { change: { type: 'move', id: root, parent: leaf } }))
      .toBe('A group cannot be moved inside itself or its children');
    expect(await load(daemon)).toEqual(before);

    await change(daemon, { type: 'move', id: leaf, parent: null });
    expect((await load(daemon)).parents).toEqual({ [child]: root });
  } finally { await daemon.stop(); }
}, 60_000);

test('removing a parent keeps its children and preserves unrelated nesting after restart', async () => {
  let daemon = await startDaemon();
  try {
    await load(daemon);
    const root = await create(daemon, 'Work');
    const child = await create(daemon, 'Research');
    const leaf = await create(daemon, 'Experiments');
    const sibling = await create(daemon, 'Planning');
    await change(daemon, { type: 'move', id: child, parent: root });
    await change(daemon, { type: 'move', id: leaf, parent: child });
    await change(daemon, { type: 'move', id: sibling, parent: root });

    await change(daemon, { type: 'remove', id: child });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    const restored = await load(daemon);
    expect(restored.groups.map((group: { name: string }) => group.name).sort())
      .toEqual(['Experiments', 'Planning', 'Work']);
    expect(restored.parents).toEqual({ [sibling]: root });

    await change(daemon, { type: 'move', id: leaf, parent: root });
    expect((await load(daemon)).parents).toEqual({ [sibling]: root, [leaf]: root });
  } finally { await daemon.stop(); }
}, 60_000);

test('moving a group checks the depth of its children before saving', async () => {
  const daemon = await startDaemon();
  try {
    await load(daemon);
    const root = await create(daemon, 'Work');
    const child = await create(daemon, 'Research');
    const leaf = await create(daemon, 'Experiments');
    const destination = await create(daemon, 'Archive');
    await change(daemon, { type: 'move', id: child, parent: root });
    await change(daemon, { type: 'move', id: leaf, parent: child });
    const before = await load(daemon);

    expect(await daemon.failure('change_session_groups', { change: { type: 'move', id: root, parent: destination } }))
      .toBe('Groups cannot exceed three levels');
    expect(await load(daemon)).toEqual(before);

    await change(daemon, { type: 'move', id: child, parent: destination });
    expect((await load(daemon)).parents).toEqual({ [child]: destination, [leaf]: child });
  } finally { await daemon.stop(); }
}, 60_000);
