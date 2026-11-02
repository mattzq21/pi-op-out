import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  await agents.enableAgentTools('spawn_subagents');
}, 60000);
afterAll(async () => { await agents?.close(); });

async function scenario(id: number, lag: number) {
  const late = Promise.withResolvers<void>();
  let wakes = 0;
  agents.scripts.set(`Spawn pair ${id}`, async messages => {
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Early', task: `Report early ${id}` }, { nickname: 'Late', task: `Report late ${id}` }] } };
    if (!called(messages, 'bash')) return { tool: 'bash', arguments: { command: 'sleep 2' } };
    if (messages.at(-1).role === 'tool') { late.resolve(); await Bun.sleep(lag); return { text: 'All done.' }; }
    wakes++;
    return { text: 'Ack ' + wakes };
  });
  agents.scripts.set(`Report early ${id}`, () => ({ text: 'Early report.' }));
  agents.scripts.set(`Report late ${id}`, async () => { await late.promise; return { text: 'Late report.' }; });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: `Spawn pair ${id}` });
  await root.until(history => history.some((message: any) => message.role === 'assistant' && JSON.stringify(message.content).includes('Ack 1')));
  await Bun.sleep(3000);
  const entries = (await root.command({ type: 'get_entries' })).entries;
  const done = Date.parse(entries.find((entry: any) => entry.message?.role === 'assistant' && JSON.stringify(entry.message.content).includes('All done.')).timestamp);
  const lateRun = entries.find((entry: any) => entry.customType === 'piop-subagent-result' && entry.details.runs[0].name === 'Late').details.runs[0];
  return { lag, finishedBeforeDone: lateRun.endedAt < done, margin: done - lateRun.endedAt, wakes };
}

test('a result found before the parent settles wakes it together with the others', async () => {
  const outcomes = await Promise.all([300, 450, 600, 750, 900, 1050].map((lag, index) => scenario(index, lag)));
  expect(outcomes.filter(outcome => outcome.finishedBeforeDone && outcome.wakes !== 1)).toEqual([]);
}, 120000);
