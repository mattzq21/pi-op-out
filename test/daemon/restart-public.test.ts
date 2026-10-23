import { expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';
import { startDaemon } from './harness';
import { stoppedJob } from './stopped-job';

test.concurrent('an active goal stops with the daemon and goes on when its chat is opened after the restart', async () => {
  const agents = await agentDaemon();
  const third = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const held = Promise.withResolvers<{ text: string }>();
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    await agents.enableAgentTools('update_goal_status');
    let turns = 0;
    agents.scripts.set('Goal across a restart', () => {
      turns++;
      if (turns === 3) { third.resolve(); return held.promise; }
      if (turns === 5) { resumed.resolve(); return held.promise; }
      return { text: 'Turn ' + turns };
    });
    const chat = await agents.rootChat();
    await chat.command({ type: 'follow_up', message: '/goal Goal across a restart', goalSubmissionId: crypto.randomUUID() });
    await third.promise;
    await agents.daemon.stop();
    const atStop = turns;
    second = await startDaemon({ home: agents.daemon.home });
    expect(await second.invoke('check_daemon_idle')).toBeNull();
    expect(turns).toBe(atStop);
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    await resumed.promise;
    expect(turns).toBeGreaterThanOrEqual(atStop + 2);
    const command = (value: any) => second!.invoke('pi_command', { runtimeId: 'reopened', command: value });
    await command({ type: 'follow_up', message: '/goal pause', goalSubmissionId: crypto.randomUUID() });
    const event = await second.waitEvent('pi://event', payload => payload.runtimeId === 'reopened'
      && payload.event?.statusKey === 'piop-goal' && JSON.parse(payload.event.statusText).status === 'paused');
    const goal = JSON.parse(event.event.statusText);
    expect(goal).toMatchObject({ status: 'paused', objective: 'Goal across a restart' });
  } finally { await second?.stop(); await agents.daemon.stop(); held.resolve({ text: 'Stopped' }); await agents.model.close(); }
}, 90000);

test.concurrent('a child cut off by a daemon restart is reported to its parent as cancelled once the parent is opened again', async () => {
  const agents = await agentDaemon();
  const jobs: Array<() => Promise<void>> = [];
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    await agents.enableAgentTools('spawn_subagents');
    const job = await stoppedJob('survivor-late.txt', jobs);
    const childReady = Promise.withResolvers<void>();
    agents.scripts.set('Delegate across a restart', messages => called(messages, 'spawn_subagents') ? { text: 'Parent saw: ' + text(messages.at(-1)) } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Survivor', task: 'Survivor job' }] } });
    agents.scripts.set('Survivor job', messages => {
      childReady.resolve();
      return called(messages, 'bash') ? { text: 'Relay: survived' } : { tool: 'bash', arguments: { command: job.command } };
    });
    const root = await agents.rootChat();
    await root.command({ type: 'prompt', message: 'Delegate across a restart' });
    await childReady.promise;
    await job.started();
    await agents.daemon.stop();
    await job.stopped();
    second = await startDaemon({ home: agents.daemon.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === root.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: root.cwd, sessionPath: path });
    let last = '';
    for (let tries = 0; !/^Parent saw: <subagent_response>\nSubagent Survivor:/.test(last) && tries < 200; tries++, await Bun.sleep(100)) {
      last = text((await second.invoke('pi_command', { runtimeId: 'reopened', command: { type: 'get_entries' } })).entries.filter((entry: any) => entry.type === 'message').at(-1)?.message);
    }
    expect(last).toMatch(/^Parent saw: <subagent_response>\nSubagent Survivor:\n/);
    expect(agents.model.requests.some(request => text(request.messages.at(-1)).includes('Relay: survived'))).toBe(false);
  } finally { await second?.stop(); await agents.daemon.stop(); await agents.model.close(); for (const close of jobs) await close(); }
}, 90000);
