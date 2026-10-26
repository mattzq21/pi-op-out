import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

test('pins reach every view of a chat, stop at four, and come back when a view attaches again', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('Plan the release', () => ({ text: 'Release plan ready.' }));
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Plan the release' });
    await chat.until(history => text(history.at(-1)) === 'Release plan ready.');
    const { sessionFile } = await chat.command({ type: 'get_state' });
    const pinsOf = (runtimeId: string, check: (pins: any[]) => boolean) => agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.type === 'pinned_messages' && check(payload.event.pins));
    const attached = pinsOf('second', pins => pins.length === 0);
    await agents.daemon.invoke('start_pi', { runtimeId: 'second', clientId: 'laptop', cwd: chat.cwd, sessionPath: sessionFile });
    await attached;

    const shown = pinsOf('second', pins => pins.length === 1);
    await chat.command({ type: 'pin_message', entryId: 'one', text: '\n  Release plan ready.\nSecond line' });
    expect((await shown).event.pins).toEqual([{ entryId: 'one', text: 'Release plan ready.' }]);
    for (const entryId of ['two', 'three', 'four']) await chat.command({ type: 'pin_message', entryId, text: entryId });
    expect(await agents.daemon.failure('pi_command', { runtimeId: 'second', command: { type: 'pin_message', entryId: 'five', text: 'five' } })).toBe('Only 4 messages can be pinned. Unpin one first.');

    const ids = (pins: any[]) => pins.map(pin => pin.entryId).join();
    const unpinned = pinsOf(chat.runtimeId, pins => ids(pins) === 'one,three,four');
    await agents.daemon.invoke('pi_command', { runtimeId: 'second', command: { type: 'unpin_message', entryId: 'two' } });
    await unpinned;

    await agents.daemon.invoke('stop_pi', { runtimeId: 'second' });
    const seen = agents.daemon.events.length;
    const restored = agents.daemon.waitEvent('pi://event', payload => agents.daemon.events.findIndex(event => event.payload === payload) >= seen && payload.runtimeId === 'second' && payload.event?.type === 'pinned_messages');
    await agents.daemon.invoke('start_pi', { runtimeId: 'second', clientId: 'laptop', cwd: chat.cwd, sessionPath: sessionFile });
    expect((await restored).event.pins.map((pin: any) => pin.text)).toEqual(['Release plan ready.', 'three', 'four']);
  } finally { await agents.close(); }
}, 120000);
