import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

test('compacting a chat replaces its oldest part with a summary, tells the app, and the summary is still used after reopening', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('My favourite animal is the otter', messages => /context summarization assistant/.test(text(messages[0]))
      ? { text: 'Summary of My favourite animal is the otter: the user likes otters.' }
      : { text: 'Noted: ' + text(messages.at(-1)).slice(0, 20) });
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'My favourite animal is the otter' });
    await chat.until(history => text(history.at(-1)).startsWith('Noted'));
    // Compaction keeps the most recent part, so the chat needs enough later text to have an older part to summarize.
    for (const fact of [1, 2, 3]) {
      await chat.command({ type: 'prompt', message: `Fact ${fact}: ` + 'filler words '.repeat(3000) });
      await chat.until(history => text(history.at(-1)).startsWith(`Noted: Fact ${fact}`));
    }

    const from = agents.daemon.events.length;
    expect(await chat.command({ type: 'compact' })).toMatchObject({ summary: 'Summary of My favourite animal is the otter: the user likes otters.' });
    const phases = agents.daemon.events.slice(from).filter(event => event.payload?.runtimeId === chat.runtimeId).map(event => event.payload.event?.type).filter(type => /compaction/.test(type));
    expect(phases).toEqual(['compaction_start', 'compaction_end']);

    /** What the model receives for the next message, as role and text. */
    const nextRequest = async (send: (message: any) => Promise<unknown>, message: string) => {
      const before = agents.model.requests.length;
      await send({ type: 'prompt', message });
      for (let tries = 0; agents.model.requests.length === before && tries < 100; tries++) await Bun.sleep(50);
      return agents.model.requests[before].messages.map((item: any) => [item.role, text(item)]);
    };
    const seen = await nextRequest(chat.command, 'What do I like?');
    expect(seen[1][1]).toContain('Summary of My favourite animal is the otter: the user likes otters.');
    expect(seen.some(([, content]: string[]) => content === 'My favourite animal is the otter')).toBe(false);
    await chat.until(history => text(history.at(-1)).startsWith('Noted: What'));

    await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
    await agents.daemon.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    const again = await nextRequest(command => agents.daemon.invoke('pi_command', { runtimeId: 'reopened', command }), 'And after reopening?');
    expect(again[1][1]).toContain('the user likes otters');
    expect(again.some(([, content]: string[]) => content === 'My favourite animal is the otter')).toBe(false);
  } finally { await agents.close(); }
}, 120000);
