import { remoteMachine, startDaemon, useRemotes } from './harness';
import { scriptedModel } from './scripted-model';

let daemon = await startDaemon();
const remotes = [];
const model = process.env.PIOP_TEST_UI_MODEL === 'echo' ? await scriptedModel(daemon.home, request => {
  const last = request.messages.at(-1);
  const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part: any) => part.text ?? '').join('');
  if (content.startsWith('Slow ')) return new Promise(resolve => setTimeout(() => resolve({ text: 'Reply to ' + content }), 3000));
  return { text: 'Reply to ' + content };
}) : undefined;
try {
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
  await daemon.stop();
  await model?.close();
  for (const remote of remotes) await remote.stop();
}
