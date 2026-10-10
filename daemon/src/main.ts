import * as restartArtifacts from './restart_artifacts';
import * as daemonLog from './daemon_log';
import { runSessionClaim } from './session_worker';
import { runDaemon } from './lifecycle';
import { errorText } from './util/sync';

const ACCEPTED = new Set(['start', 'stop', '--serve', '--exit-on-disconnect', '--stdio-client', '--restart-coordinator', '--validate-plugins', '--restart-candidate', '--daemon-log-writer']);

function fail(prefix: string, error: unknown): never {
  process.stderr.write(prefix + errorText(error) + '\n');
  process.exit(1);
}

async function main(): Promise<void> {
  const first = process.argv[2];
  if (first === '--piop-session-claim') runSessionClaim();
  try {
    restartArtifacts.initialize();
    await daemonLog.initialize();
  } catch (error) {
    if (first === '--daemon-log-sink') process.stdout.write('piopd: ' + errorText(error) + '\n');
    fail('piopd: ', error);
  }
  if (first === '--daemon-log-sink') {
    try { await daemonLog.runSink(); } catch (error) { fail('piopd logging: ', error); }
    return;
  }
  if (first === undefined || first === '--help' || first === '-h') {
    process.stdout.write('Usage: piopd <start|stop>\n\n  start  Run the daemon in the background until stopped\n  stop   Shut down the running daemon gracefully\n');
    return;
  }
  if (!ACCEPTED.has(first)) {
    process.stderr.write('piopd: Unknown command ' + first + '. Use piopd --help.\n');
    process.exit(1);
  }
  try { await runDaemon(); } catch (error) { fail('piopd: ', error); }
  process.exit(0);
}

main().catch(error => fail('piopd: ', error));
