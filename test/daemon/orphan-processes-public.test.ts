import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { agentDaemon, called, text } from './agent-chats';
import { startDaemon } from './harness';

/** Processes whose command line contains marker, with the PIOP_PROCESS_TAG they carry. */
function processes(marker: string) {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').includes(marker)) return [];
      const tag = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith('PIOP_PROCESS_TAG='))?.slice('PIOP_PROCESS_TAG='.length);
      return [{ pid: Number(pid), tag }];
    } catch { return []; }
  });
}

/** Has an agent of agents start a background sleep with marker, and returns that process. */
async function backgroundSleep(agents: Awaited<ReturnType<typeof agentDaemon>>, marker: string) {
  agents.scripts.set('Start a long job', messages => called(messages, 'bash') ? { text: 'Job started.' } : { tool: 'bash', arguments: { command: `setsid sleep ${marker} > /dev/null 2>&1 &` } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Start a long job' });
  await chat.until(history => text(history.at(-1)) === 'Job started.');
  return processes('sleep ' + marker);
}

test.concurrent('programs an agent left running are stopped when the next daemon starts after a crash, and other daemons keep theirs', async () => {
  const agents = await agentDaemon();
  const running = await agentDaemon();
  const marker = '6000.' + Math.floor(Math.random() * 1e6);
  const kept = '7000.' + Math.floor(Math.random() * 1e6);
  let left: ReturnType<typeof processes> = [];
  try {
    left = await backgroundSleep(agents, marker);
    expect(left).toHaveLength(1);
    expect(left[0].tag).toMatch(/^\d+\.\d+\./);
    expect(await backgroundSleep(running, kept)).toHaveLength(1);

    // The daemon crashes: it and everything in its process tree that it would have stopped are killed at once.
    const daemonPid = Number(left[0].tag!.split('.')[0]);
    process.kill(daemonPid, 'SIGKILL');
    for (let tries = 0; tries < 100 && readdirSync('/proc').includes(String(daemonPid)); tries++) await Bun.sleep(50);
    expect(processes('sleep ' + marker)).toHaveLength(1);

    const next = await startDaemon({ home: agents.daemon.home });
    try {
      for (let tries = 0; tries < 100 && processes('sleep ' + marker).length; tries++) await Bun.sleep(50);
      expect(processes('sleep ' + marker)).toEqual([]);
      expect(processes('sleep ' + kept), 'a running daemon keeps its programs').toHaveLength(1);
    } finally { await next.stop(); }
  } finally {
    for (const { pid } of [...processes('sleep ' + marker), ...processes('sleep ' + kept)]) process.kill(pid, 'SIGKILL');
    await agents.close().catch(() => {});
    await running.close().catch(() => {});
  }
}, 120000);

test.concurrent('a clean daemon stop also stops the programs its agents left running', async () => {
  const agents = await agentDaemon();
  const marker = '6200.' + Math.floor(Math.random() * 1e6);
  try {
    expect(await backgroundSleep(agents, marker)).toHaveLength(1);
    await agents.close();
    for (let tries = 0; tries < 100 && processes('sleep ' + marker).length; tries++) await Bun.sleep(50);
    expect(processes('sleep ' + marker)).toEqual([]);
  } finally {
    for (const { pid } of processes('sleep ' + marker)) process.kill(pid, 'SIGKILL');
    await agents.close().catch(() => {});
  }
}, 120000);

test.concurrent('stopping an agent while its command runs ends that command and the turn, without asking the model again', async () => {
  const agents = await agentDaemon();
  const marker = '6500.' + Math.floor(Math.random() * 1e6);
  try {
    agents.scripts.set('Run a slow build', messages => called(messages, 'bash') ? { text: 'Build done.' } : { tool: 'bash', arguments: { command: 'sleep ' + marker } });
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Run a slow build' });
    for (let tries = 0; tries < 100 && !processes('sleep ' + marker).length; tries++) await Bun.sleep(50);
    expect(processes('sleep ' + marker)).toHaveLength(1);
    const asked = agents.model.requests.length;
    await chat.command({ type: 'abort' });
    for (let tries = 0; tries < 60 && processes('sleep ' + marker).length; tries++) await Bun.sleep(50);
    expect(processes('sleep ' + marker)).toEqual([]);
    const history = await chat.until(messages => messages.at(-1)?.role === 'assistant' && messages.at(-1).stopReason === 'aborted');
    expect(history.some(message => text(message) === 'Build done.')).toBe(false);
    await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
    expect(agents.model.requests.length).toBe(asked);
  } finally {
    for (const { pid } of processes('sleep ' + marker)) process.kill(pid, 'SIGKILL');
    await agents.close().catch(() => {});
  }
}, 120000);
