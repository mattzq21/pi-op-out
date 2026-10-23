import * as restartArtifacts from './restart_artifacts';
import * as daemonLog from './daemon_log';
import { runSessionClaim } from './session_worker';
import { installFailureHandlers, runDaemon } from './lifecycle';
import { ALREADY_RUNNING_EXIT_CODE, DaemonAlreadyRunningError } from './daemon_endpoint';
import { PROCESS_TAG } from './process_cleanup';
import { errorText } from './util/sync';
import { isHostOperationWorker, runHostOperationWorker } from './host_operation_worker';

const ACCEPTED = new Set(['start', 'stop', '--serve', '--exit-on-disconnect', '--stdio-client', '--restart-coordinator', '--validate-plugins', '--restart-candidate', '--daemon-log-writer']);

function fail(prefix: string, error: unknown): never {
  process.stderr.write(prefix + errorText(error) + '\n');
  process.exit(error instanceof DaemonAlreadyRunningError ? ALREADY_RUNNING_EXIT_CODE : 1);
}

async function main(): Promise<void> {
  // Host operation workers load this same bundle; they only run the jobs that the daemon sends them.
  if (isHostOperationWorker()) { runHostOperationWorker(); return; }
  const first = process.argv[2];
  // A daemon started from an agent's shell inherits that agent's tag. Removing it keeps the processes this daemon starts from being stopped with that agent.
  delete process.env[PROCESS_TAG];
  installFailureHandlers();
  if (first === '--daemon-log-sink' || first === '--daemon-log-writer') {
    try {
      if (first === '--daemon-log-sink') await daemonLog.runSink(); else await daemonLog.run();
    } catch { process.exitCode = 1; }
    return;
  }
  if (first === '--piop-session-claim') runSessionClaim();
  try {
    await restartArtifacts.initialize();
    await daemonLog.initialize();
  } catch (error) {
    fail('piopd: ', error);
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
