import * as restartArtifacts from './restart';
import * as daemonLog from './service';
import { installFailureHandlers, runDaemon } from './lifecycle';
import { ALREADY_RUNNING_EXIT_CODE, DaemonAlreadyRunningError, connection } from './service';
import { PROCESS_TAG } from './process';
import { errorText } from './util/sync';
import { isHostOperationWorker, runHostOperationWorker } from './host_operations';
import { STORAGE_DIRECTORY } from './environment';
import { readOnlyStorage } from '../resources/session-database/index.ts';
import { stateRecords } from './plugins';

// The modes that run the daemon. Each takes the daemon lock before it changes the storage.
const OWNERS = new Set(['--serve', '--restart-candidate']);

const ACCEPTED = new Set(['start', 'stop', '--serve', '--stdio-client', '--restart-coordinator', '--validate-plugins', '--restart-candidate', '--daemon-log-writer']);

function fail(prefix: string, error: unknown): never {
  process.stderr.write(prefix + errorText(error) + '\n');
  process.exit(error instanceof DaemonAlreadyRunningError ? ALREADY_RUNNING_EXIT_CODE : 1);
}

async function main(): Promise<void> {
  if (isHostOperationWorker()) { runHostOperationWorker(); return; }
  const first = process.argv[2];
  delete process.env[PROCESS_TAG];
  // The storage code that the daemon shares with Pi finds the storage folder through this variable.
  process.env.PIOP_STORAGE_DIRECTORY = STORAGE_DIRECTORY;
  // The storage code finds the custom entries of the plugins that keep only their last value through this variable.
  process.env.PIOP_PLUGIN_STATE_RECORDS = JSON.stringify(stateRecords());
  // The other modes (start, stop, the client, the restart coordinator and checks) only read the storage.
  if (!OWNERS.has(first ?? '')) readOnlyStorage();
  installFailureHandlers();
  // Prints, for the desktop app, how to connect to the running daemon.
  if (first === '--connection') {
    try { process.stdout.write(JSON.stringify(connection()) + '\n'); } catch (error) { fail('piopd: ', error); }
    return;
  }
  if (first === '--daemon-log-sink' || first === '--daemon-log-writer') {
    try {
      if (first === '--daemon-log-sink') await daemonLog.runSink(); else await daemonLog.runLogWriter();
    } catch { process.exitCode = 1; }
    return;
  }
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
