import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

test.concurrent('compacting a chat replaces its oldest part with a summary, tells the app, and the summary is still used after reopening', async () => {
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

/** Runs three long turns that each report 95,000 input tokens, in a chat started with the given context cap settings. */
async function longChat(cap: { contextWindowCap: number; contextWindowCapEnabled: boolean }) {
  const agents = await agentDaemon();
  const settings = await agents.daemon.invoke('load_app_settings');
  await agents.daemon.invoke('save_app_settings', { settings: { ...settings, ...cap, autoCompaction: true } });
  let step = 0;
  agents.scripts.set('Long project', messages => /context summarization assistant/.test(text(messages[0]))
    ? { text: 'Summary of Long project: earlier steps are done.' }
    : { text: 'Step ' + ++step, tokens: 95_000 });
  const chat = await agents.rootChat();
  // The app turns automatic compaction on for each chat it opens.
  await chat.command({ type: 'set_auto_compaction', enabled: true });
  // Compaction keeps the most recent part, so the turns carry enough text to leave an older part to summarize.
  for (const turn of [1, 2, 3]) {
    const seen = new Set(agents.daemon.events.map(event => event.payload));
    await chat.command({ type: 'prompt', message: turn === 1 ? 'Long project' : `Continue ${turn} ` + 'filler '.repeat(12000) });
    await chat.until(history => history.filter(message => message.role === 'assistant' && text(message).startsWith('Step')).length >= turn);
    await agents.daemon.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled', 60000);
  }
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  const reasons = agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.type === 'compaction_end').map(event => event.payload.event.reason);
  await agents.close();
  return { summaries: entries.filter((entry: any) => entry.type === 'compaction').map((entry: any) => entry.summary), reasons };
}

test.concurrent('a chat that reaches the context cap from Settings is compacted by itself, and without the cap the same chat is not', async () => {
  const capped = await longChat({ contextWindowCap: 100_000, contextWindowCapEnabled: true });
  expect(capped.summaries.length).toBeGreaterThan(0);
  expect(capped.summaries.every((summary: string) => summary === 'Summary of Long project: earlier steps are done.')).toBe(true);
  expect(new Set(capped.reasons)).toEqual(new Set(['threshold']));

  // The scripted model allows 200,000 tokens, so 95,000 leaves plenty of room.
  const uncapped = await longChat({ contextWindowCap: 100_000, contextWindowCapEnabled: false });
  expect(uncapped.summaries).toEqual([]);
}, 240000);

test.concurrent('compacting while the agent works is refused with how to do it, and the running response goes on', async () => {
  const agents = await agentDaemon();
  try {
    let release!: (reply: { text: string }) => void;
    const busy = new Promise<{ text: string }>(resolve => { release = resolve; });
    agents.scripts.set('Busy chat', () => busy);
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Busy chat' });
    await chat.until(() => agents.model.requests.length > 0);
    expect(await chat.command({ type: 'compact' }).then(() => 'compacted', (error: Error) => error.message)).toBe('Stop or pause piop before running /compact.');
    release({ text: 'Finished anyway.' });
    const history = await chat.until(messages => text(messages.at(-1)) === 'Finished anyway.');
    expect(history.some(message => message.stopReason === 'aborted')).toBe(false);
  } finally { await agents.close(); }
}, 60000);

test.concurrent('a goal goes on working after its chat is compacted by itself between two turns', async () => {
  const agents = await agentDaemon();
  try {
    await agents.enableAgentTools('update_goal_status');
    const settings = await agents.daemon.invoke('load_app_settings');
    await agents.daemon.invoke('save_app_settings', { settings: { ...settings, contextWindowCap: 100_000, contextWindowCapEnabled: true, autoCompaction: true } });
    let turns = 0;
    agents.scripts.set('Long goal', async messages => {
      if (/context summarization assistant/.test(text(messages[0]))) return { text: 'Summary of Long goal: earlier turns are done.' };
      await Bun.sleep(200);
      return { text: 'Turn ' + ++turns + ' ' + 'filler '.repeat(4000), tokens: turns === 3 ? 95_000 : 1000 };
    });
    const chat = await agents.rootChat();
    await chat.command({ type: 'set_auto_compaction', enabled: true });
    await chat.command({ type: 'follow_up', message: '/goal Long goal', goalSubmissionId: crypto.randomUUID() });
    const compacted = () => agents.daemon.events.some(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.type === 'compaction_end');
    for (let tries = 0; !compacted() && tries < 300; tries++) await Bun.sleep(100);
    expect(compacted()).toBe(true);
    const atCompaction = turns;
    for (let tries = 0; turns < atCompaction + 2 && tries < 100; tries++) await Bun.sleep(100);
    expect(turns).toBeGreaterThanOrEqual(atCompaction + 2);
    await chat.command({ type: 'follow_up', message: '/goal pause', goalSubmissionId: crypto.randomUUID() });
  } finally { await agents.close(); }
}, 120000);
