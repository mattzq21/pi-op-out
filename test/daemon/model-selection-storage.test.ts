import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

for (const withHistory of [false, true]) test.concurrent(`current model and thinking survive reopening ${withHistory ? 'with' : 'without'} messages`, async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('First question', () => ({ text: 'First answer' }));
    const chat = await agents.rootChat({ repository: withHistory });
    if (withHistory) {
      await chat.command({ type: 'prompt', message: 'First question' });
      await chat.until(history => text(history.at(-1)) === 'First answer');
    }
    const state = await chat.command({ type: 'get_state' });
    const body = readFileSync(state.sessionFile, 'utf8');
    await chat.command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-thinker' });
    await chat.command({ type: 'set_thinking_level', level: 'high' });
    expect(readFileSync(state.sessionFile, 'utf8')).toBe(body);
    if (withHistory) {
      const answer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && entry.message.role === 'assistant');
      await chat.command({ type: 'fork_and_forget', entryId: answer.id });
      expect(await chat.command({ type: 'get_state' })).toMatchObject({ model: { id: 'scripted-thinker' }, thinkingLevel: 'high' });
      await chat.command({ type: 'fork_after', entryId: answer.id });
      expect(await chat.command({ type: 'get_state' })).toMatchObject({ model: { id: 'scripted-thinker' }, thinkingLevel: 'high' });
      await chat.command({ type: 'switch_session', sessionPath: state.sessionFile });
    }
    await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
    await agents.daemon.invoke('start_pi', { runtimeId: chat.runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: state.sessionId });
    expect(await chat.command({ type: 'get_state' })).toMatchObject({ model: { id: 'scripted-thinker' }, thinkingLevel: 'high' });
    const physical = readFileSync(state.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(physical.some(entry => ['model_change', 'thinking_level_change'].includes(entry.type))).toBe(false);
    const db = new Database(join(agents.daemon.home, '.piop', 'sessions.sqlite'), { readonly: true });
    try {
      const rows = db.query("SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? AND state_key IN ('piop-selected-model', 'piop-thinking-level')").all(state.sessionId) as { state_key: string; entry_json: string }[];
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows.find(row => row.state_key === 'piop-selected-model')!.entry_json).modelId).toBe('scripted-thinker');
      expect(JSON.parse(rows.find(row => row.state_key === 'piop-thinking-level')!.entry_json).thinkingLevel).toBe('high');
    } finally { db.close(); }
  } finally { await agents.close(); }
}, 60000);
