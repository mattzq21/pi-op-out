import { expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';
import { startDaemon } from './harness';

test('an active goal stops with the daemon and goes on when its chat is opened after the restart', async () => {
  const agents = await agentDaemon();
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    await agents.enableAgentTools('update_goal_status');
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
    let goal: any = null;
    for (let tries = 0; goal?.status !== 'paused' && tries < 50; tries++, await Bun.sleep(100)) { const status = second.events.filter((event: any) => event.payload?.runtimeId === 'reopened' && event.payload.event?.statusKey === 'piop-goal').at(-1)?.payload.event.statusText; goal = status ? JSON.parse(status) : null; }
    expect(goal).toMatchObject({ status: 'paused', objective: 'Goal across a restart' });
  } finally { await second?.stop(); await agents.model.close(); }
}, 90000);

test('a child cut off by a daemon restart is reported to its parent as cancelled once the parent is opened again', async () => {
  const agents = await agentDaemon();
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    agents.scripts.set('Delegate across a restart', messages => called(messages, 'spawn_agent') ? { text: 'Parent saw: ' + text(messages.at(-1)) } : { tool: 'spawn_agent', arguments: { task_name: 'survivor', message: 'Survivor job' } });
    agents.scripts.set('Survivor job', messages => called(messages, 'bash') ? { text: 'Relay: survived' } : { tool: 'bash', arguments: { command: 'sleep 4' } });
    const root = await agents.rootChat();
    await root.command({ type: 'prompt', message: 'Delegate across a restart' });
    const childStarted = () => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Survivor job') && text(request.messages.at(-1)).startsWith('Untrusted agent content'));
    for (let tries = 0; !childStarted() && tries < 200; tries++) await Bun.sleep(100);
    await Bun.sleep(800);
    await agents.daemon.stop();
    second = await startDaemon({ home: agents.daemon.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === root.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: root.cwd, sessionPath: path });
    let last = '';
    for (let tries = 0; !/survivor: cancelled/.test(last) && tries < 200; tries++, await Bun.sleep(100)) {
      last = text((await second.invoke('pi_command', { runtimeId: 'reopened', command: { type: 'get_entries' } })).entries.filter((entry: any) => entry.type === 'message').at(-1)?.message);
    }
    expect(last).toStartWith('Parent saw: Untrusted agent content delivered by piop:\nsurvivor: cancelled');
    expect(agents.model.requests.some(request => text(request.messages.at(-1)).includes('Relay: survived'))).toBe(false);
  } finally { await second?.stop(); await agents.model.close(); }
}, 90000);
