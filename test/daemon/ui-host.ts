import { remoteMachine, startDaemon, useRemotes } from './harness';
import { scriptedModel } from './scripted-model';

const daemon = await startDaemon();
const remotes = [];
// With PIOP_TEST_UI_MODEL=echo, the daemon's only model answers each message with "Reply to " and the message text.
const model = process.env.PIOP_TEST_UI_MODEL === 'echo' ? await scriptedModel(daemon.home, request => {
  const last = request.messages.at(-1);
  const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part: any) => part.text ?? '').join('');
  return { text: 'Reply to ' + content };
}) : undefined;
try {
  for (const remote of JSON.parse(process.env.PIOP_TEST_UI_REMOTES ?? '[]')) remotes.push(await remoteMachine(daemon, remote.id, remote.name, remote.target));
  if (remotes.length) await useRemotes(daemon, remotes);
  process.stdout.write(JSON.stringify(daemon.endpoint) + '\n');
  process.stdin.resume();
  await new Promise<void>(resolve => process.stdin.on('end', resolve));
} finally {
  await daemon.stop();
  await model?.close();
  for (const remote of remotes) await remote.stop();
}
