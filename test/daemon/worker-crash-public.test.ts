import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { agentDaemon, text } from './agent-chats';

test('when a chat\'s Pi process dies mid-answer, the app is told, and reopening the chat keeps its history and answers again', async () => {
  const agents = await agentDaemon();
  /** The Pi processes of this test's daemon. */
  const workers = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (!env.includes('HOME=' + agents.daemon.home) || !env.some(entry => entry.startsWith('PIOP_PROCESS_TAG='))) return [];
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('pi') ? [Number(pid)] : [];
    } catch { return []; }
  });
  try {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    agents.scripts.set('Think slowly', messages => {
      if (++calls === 1) { started.resolve(); return new Promise(() => {}); }
      return { text: 'Answered: ' + text(messages.at(-1)) };
    });
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'Think slowly' });
    await started.promise;
    expect(workers()).toHaveLength(1);

    const lost = agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'disconnected');
    process.kill(workers()[0], 'SIGKILL');
    await lost;
    expect(await chat.command({ type: 'get_state' }).then(() => 'answered', (error: Error) => error.message)).toBe('Pi is not running');

    // The app reopens the chat, as it does after a disconnect.
    await agents.daemon.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    const reopened = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'reopened', command });
    const history = async () => (await reopened({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
    expect((await history()).filter((message: any) => message.role === 'user').map(text)).toEqual(['Think slowly']);
    await reopened({ type: 'prompt', message: 'Try again' });
    await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === 'reopened' && payload.event?.type === 'agent_settled');
    expect(text((await history()).at(-1))).toBe('Answered: Try again');
  } finally { await agents.close(); }
}, 120000);
