import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('update_goal_status'); }, 60000);
afterAll(async () => { await agents?.close(); });
const send = (chat: any, message: string) => chat.command({ type: 'follow_up', message, goalSubmissionId: crypto.randomUUID() });

test('old code: a follow-up sent during a goal turn runs', async () => {
  let gate: (() => void) | undefined; let blocking = true; let calls = 0;
  agents.scripts.set('Keep drafting', async messages => {
    calls++;
    if (blocking) await new Promise<void>(resolve => { gate = resolve; });
    if (messages.some((m: any) => m.role === 'user' && text(m).includes('Question one')) && !messages.some((m: any) => m.role === 'assistant' && text(m) === 'Answered one.')) return { text: 'Answered one.' };
    if (called(messages, 'update_goal_status')) return { text: 'Drafted.' };
    return messages.filter((m: any) => text(m) === 'Drafting.').length > 3 ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : { text: 'Drafting.' };
  });
  const chat = await agents.rootChat();
  await send(chat, '/goal Keep drafting');
  for (let i = 0; !gate && i < 200; i++) await Bun.sleep(50);
  await send(chat, 'Question one');
  await Bun.sleep(300);
  blocking = false; const g = gate; gate = undefined; g?.();
  const history = await chat.until(h => text(h.at(-1)) === 'Drafted.');
  expect(history.some(m => text(m) === 'Answered one.')).toBe(true);
}, 120000);
