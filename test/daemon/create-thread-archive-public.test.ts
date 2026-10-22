import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const toolResult = (messages: any[], tool: string) => {
  const call = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.some((item: any) => item.function.name === tool))?.tool_calls.find((item: any) => item.function.name === tool);
  return call && JSON.parse(text(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id)));
};

const sessions = () => join(agents.daemon.home, '.piop', 'sessions');
/** The transcripts in the active area of the test profile. */
const transcripts = () => readdirSync(sessions()).filter(name => name.endsWith('.jsonl'));

// Piop Dev, 2026-10-22 16:51: the temporary chat 8679b849 called create_thread. The new chat 197bf72a got the caller's
// temporary folder, then an archive_session request for it came while the daemon started it to deliver the prompt.
// The archive stopped the new chat, so delivery failed with "Pi is not running", and the new chat went to archived/
// with only its header. Old temporary chats were archived in the same seconds. The user did not archive.
test('BUG: an archive request during create_thread delivery archives the new chat and fails delivery with "Pi is not running"', async () => {
  await agents.enableAgentTools('send_message');
  const old = await agents.rootChat();
  agents.scripts.set('Old temporary chat', () => ({ text: 'Old answer.' }));
  await old.command({ type: 'prompt', message: 'Old temporary chat' });
  await old.until(history => text(history.at(-1)) === 'Old answer.');

  const caller = await agents.rootChat();
  agents.scripts.set('Spawn a smile chat', messages => called(messages, 'create_thread')
    ? { text: 'Created: ' + JSON.stringify(toolResult(messages, 'create_thread')) }
    : { tool: 'create_thread', arguments: { title: 'Draw an SVG to make you smile', prompt: 'Draw a smiling SVG' } });
  agents.scripts.set('Draw a smiling SVG', () => ({ text: 'SVG drawn.' }));
  const before = new Set(transcripts());
  await caller.command({ type: 'prompt', message: 'Spawn a smile chat' });

  // The archive request comes after the daemon checked that the new chat is active and started it to deliver the prompt.
  let created = '';
  for (const deadline = Date.now() + 60000; !created && Date.now() < deadline; await Bun.sleep(5)) {
    created = transcripts().find(name => !before.has(name) && readFileSync(join(sessions(), name), 'utf8').includes(caller.cwd)) ?? '';
  }
  expect(created).not.toBe('');
  await Bun.sleep(300);
  const archive = agents.daemon.invoke('archive_session', { sessionPath: join(sessions(), created), hostId: 'local', terminalIds: [], clientId: 'laptop' });

  const messages = await caller.until(history => text(history.at(-1)).startsWith('Created: '));
  await archive;
  const result = JSON.parse(text(messages.at(-1)).slice('Created: '.length));
  const id = created.slice(-42, -6);
  const state = {
    submitted: result.submitted, error: result.error ?? null,
    archived: existsSync(join(agents.daemon.home, '.piop', 'archived', 'session-' + id + '.jsonl')),
    oldChatActive: transcripts().some(name => name.includes(old.sessionId)),
  };
  // Expected: the new chat stays active and gets its prompt. Now: it is archived and delivery fails.
  expect(state).toEqual({ submitted: true, error: null, archived: false, oldChatActive: true });
}, 120000);
