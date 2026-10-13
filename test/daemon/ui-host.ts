import { remoteMachine, startDaemon, useRemotes } from './harness';

const daemon = await startDaemon();
const remotes = [];
try {
  for (const remote of JSON.parse(process.env.PIOP_TEST_UI_REMOTES ?? '[]')) remotes.push(await remoteMachine(daemon, remote.id, remote.name, remote.target));
  if (remotes.length) await useRemotes(daemon, remotes);
  process.stdout.write(JSON.stringify(daemon.endpoint) + '\n');
  process.stdin.resume();
  await new Promise<void>(resolve => process.stdin.on('end', resolve));
} finally {
  await daemon.stop();
  for (const remote of remotes) await remote.stop();
}
