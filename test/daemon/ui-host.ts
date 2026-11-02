import { remoteMachine, startDaemon, useRemotes } from './harness';
import { scriptedModel, type Reply } from './scripted-model';
import { called, saveAgentDefinitions, text } from './agent-chats';

const HELPERS: Record<string, { task: string; quick?: true }> = {
  Kitty: { task: 'Draw a derpy cat that blinks slowly in cat.svg', quick: true },
  Octo: { task: 'Draw an octopus juggling shells in octopus.svg', quick: true },
  Bloom: { task: 'Draw a flower that blooms with bees around it in bloom.svg' },
  Rocket: { task: 'Draw a rocket lift-off with flickering exhaust in rocket.svg' },
  Pixel: { task: 'Draw a pixel hero hopping over a slime in pixel.svg' },
  Toast: { task: 'Draw toast popping out of a toaster in toast.svg' },
};
const waits = new Set<() => void>();
const later = (reply: Reply) => new Promise<Reply>(resolve => { const timer = setTimeout(() => resolve(reply), 600000); waits.add(() => { clearTimeout(timer); resolve(reply); }); });

function agentsReply(request: any): Reply | Promise<Reply> {
  const users = request.messages.filter((message: any) => message.role === 'user').map(text);
  const helper = Object.values(HELPERS).find(item => item.task === users[0]);
  if (helper) return helper.quick ? { text: 'Done: ' + helper.task } : later({ text: 'Done: ' + helper.task });
  if (users.at(-1)?.startsWith('Which colours')) return later({ text: 'Warm ones.' });
  if (!users[0]?.startsWith('Draw with helpers')) return { text: 'Reply to ' + users.at(-1) };
  if (!called(request.messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: Object.entries(HELPERS).map(([nickname, item]) => ({ nickname, task: item.task })) } };
  if (!called(request.messages, 'await_subagents')) return { tool: 'await_subagents', arguments: { for: 'all' } };
  return { text: 'All drawn.' };
}

let daemon = await startDaemon();
const remotes = [];
const mode = process.env.PIOP_TEST_UI_MODEL;
const model = mode === 'echo' ? await scriptedModel(daemon.home, request => {
  const last = request.messages.at(-1);
  const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part: any) => part.text ?? '').join('');
  if (content.startsWith('Slow ')) return new Promise(resolve => setTimeout(() => resolve({ text: 'Reply to ' + content }), 3000));
  return { text: 'Reply to ' + content };
}) : mode === 'agents' ? await scriptedModel(daemon.home, agentsReply) : undefined;
try {
  if (mode === 'agents') await saveAgentDefinitions(daemon, agents => agents.map(agent => ({ ...agent, tools: [...new Set([...(agent.tools ?? []), 'spawn_subagents'])] })));
  if (model) {
    const settings = await daemon.invoke('load_app_settings');
    settings.knownModels = ['scripted/scripted-model', 'scripted/scripted-thinker'];
    settings.hiddenModels = [];
    await daemon.invoke('save_app_settings', { settings });
  }
  for (const remote of JSON.parse(process.env.PIOP_TEST_UI_REMOTES ?? '[]')) remotes.push(await remoteMachine(daemon, remote.id, remote.name, remote.target));
  if (remotes.length) await useRemotes(daemon, remotes);
  process.stdout.write(JSON.stringify(daemon.endpoint) + '\n');
  const lines = (await import('node:readline')).createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line === 'restart') {
      await daemon.stop();
      daemon = await startDaemon({ home: daemon.home });
      process.stdout.write(JSON.stringify(daemon.endpoint) + '\n');
    } else if (line === 'requests') {
      process.stdout.write(JSON.stringify((model?.requests ?? []).map(request => {
        const last = request.messages.findLast((message: any) => message.role === 'user');
        return typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part: any) => part.text ?? '').join('');
      })) + '\n');
    } else process.stdout.write(JSON.stringify({ error: 'Unknown command ' + line }) + '\n');
  }
} finally {
  for (const release of waits) release();
  await daemon.stop();
  await model?.close();
  for (const remote of remotes) await remote.stop();
}
