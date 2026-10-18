import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import { startDaemon } from './harness';

test('an active goal stops with the daemon and goes on when its chat is opened after the restart', async () => {
  const agents = await agentDaemon();
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    await agents.enableAgentTools('get_goal', 'create_goal', 'update_goal');
    let turns = 0;
    agents.scripts.set('Goal across a restart', async () => { turns++; await Bun.sleep(300); return { text: 'Turn ' + turns }; });
    const chat = await agents.rootChat();
    await chat.command({ type: 'follow_up', message: '/goal Goal across a restart', goalSubmissionId: crypto.randomUUID() });
    for (let tries = 0; turns < 3 && tries < 100; tries++) await Bun.sleep(100);
    await agents.daemon.stop();
    const atStop = turns;
    second = await startDaemon({ home: agents.daemon.home });
    await Bun.sleep(2000);
    expect(turns).toBe(atStop);
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    for (let tries = 0; turns < atStop + 2 && tries < 100; tries++) await Bun.sleep(100);
    expect(turns).toBeGreaterThanOrEqual(atStop + 2);
    const command = (value: any) => second!.invoke('pi_command', { runtimeId: 'reopened', command: value });
    await command({ type: 'follow_up', message: '/goal pause', goalSubmissionId: crypto.randomUUID() });
    await command({ type: 'follow_up', message: '/goal', goalSubmissionId: crypto.randomUUID() });
    let summary = '';
    for (let tries = 0; !summary.startsWith('Goal paused') && tries < 50; tries++, await Bun.sleep(100)) summary = (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.customType === 'piop-goal-summary').map((entry: any) => text(entry)).at(-1) ?? '';
    expect(summary).toStartWith('Goal paused\n\nGoal across a restart');
  } finally { await second?.stop(); await agents.model.close(); }
}, 90000);
