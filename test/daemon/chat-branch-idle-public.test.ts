import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { agentDaemon, called, text } from './agent-chats';

for (const [mode, repository] of [['fork_after', true], ['copy_after', true], ['copy_after', false]] as const) test.concurrent(`${mode} (${repository ? 'repository' : 'plain folder'}) keeps an active goal idle until user input`, async () => {
  const agents = await agentDaemon();
  try {
    await agents.enableAgentTools('update_goal_status');
    let finish = false;
    agents.scripts.set('Idle branch question', async messages => {
      await Bun.sleep(150);
      if (called(messages, 'update_goal_status')) return { text: 'Goal done.' };
      if (messages.filter(message => message.role === 'user').length === 1) return { text: 'First answer.' };
      const prompt = messages.findIndex(message => message.role === 'user' && text(message) === 'Branch prompt');
      if (prompt >= 0 && !messages.slice(prompt).some(message => message.role === 'assistant')) return { text: 'Branch answer.' };
      return finish ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : { text: 'Goal turn.' };
    });
    const source = await agents.rootChat({ repository });
    await source.command({ type: 'prompt', message: 'Idle branch question' });
    await source.until(messages => text(messages.at(-1)) === 'First answer.');
    const answer = (await source.command({ type: 'get_entries' })).entries.find((entry: any) => entry.message?.role === 'assistant');
    await source.command({ type: 'follow_up', message: '/goal Keep the branch going', goalSubmissionId: crypto.randomUUID() });
    await source.until(messages => messages.some(message => text(message) === 'Goal turn.'));

    await source.command({ type: mode, entryId: answer.id });
    const branch = await source.command({ type: 'get_state' });
    expect(branch.forkSource).toMatchObject({ entryId: answer.id });
    const visible = async () => (await source.history()).filter(message => ['user', 'assistant'].includes(message.role)).map(text);
    const db = new Database(join(agents.daemon.home, '.piop', 'sessions.sqlite'), { readonly: true });
    const goal = () => db.query('SELECT objective, status FROM session_goals WHERE session_id=?').get(branch.sessionId) as any;
    const hold = () => JSON.parse((db.query("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'").get(branch.sessionId) as any).entry_json).data.held;
    try {
      // Long enough for the copied goal to have started several turns if the branch were not held.
      await Bun.sleep(2000);
      expect(await visible()).toEqual(['Idle branch question', 'First answer.']);
      expect((await source.command({ type: 'get_state' })).isStreaming).toBe(false);
      expect(goal()).toEqual({ objective: 'Keep the branch going', status: 'active' });
      expect(hold()).toBe(true);

      finish = true;
      // Sent the way the composer sends it.
      expect(await source.command({ type: 'follow_up', message: 'Branch prompt', goalSubmissionId: crypto.randomUUID() })).not.toBe(false);
      const messages = await source.until(history => text(history.at(-1)) === 'Goal done.');
      const replies = messages.filter(message => ['user', 'assistant'].includes(message.role)).map(text);
      // The user's message runs first; the still active goal then continues on its own until the agent completes it.
      expect(replies.slice(0, 4)).toEqual(['Idle branch question', 'First answer.', 'Branch prompt', 'Branch answer.']);
      expect(messages.slice(4).some(message => message.role === 'assistant' && message.content.some((part: any) => part.type === 'toolCall' && part.name === 'update_goal_status'))).toBe(true);
      expect(hold()).toBe(false);
      expect(goal()).toBeNull();
    } finally { db.close(); }
  } finally { await agents.close(); }
}, 120000);


test.concurrent('a chat in a repository subfolder uses normal forking and does not save Git commits', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('Subfolder chat', () => ({ text: 'Ready.' }));
    const source = await agents.rootChat({ repository: true, subfolder: 'apps/web' });
    const head = () => execFileSync('git', ['-C', source.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const before = head();
    writeFileSync(join(source.cwd, 'package.json'), '{"name":"web"}\n');
    await source.command({ type: 'prompt', message: 'Subfolder chat' });
    await source.until(messages => text(messages.at(-1)) === 'Ready.');
    const state = await source.command({ type: 'get_state' });
    expect(state.repository).toBeNull();
    const answer = (await source.command({ type: 'get_entries' })).entries.find((entry: any) => entry.message?.role === 'assistant');
    await expect(source.command({ type: 'fork_after', entryId: answer.id })).rejects.toThrow('This folder is not a Git repository');
    await source.command({ type: 'copy_after', entryId: answer.id });
    const fork = await source.command({ type: 'get_state' });
    expect(fork.sessionId).not.toBe(state.sessionId);
    expect(fork.cwd).toBe(source.cwd);
    expect(fork.repository).toBeNull();
    expect(head()).toBe(before);
  } finally { await agents.close(); }
}, 120000);
