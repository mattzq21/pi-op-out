import { App } from './app';
import { DEVELOPMENT } from './config';
import * as daemonEndpoint from './daemon_endpoint';
import * as daemonStdio from './daemon_stdio';
import * as daemonRestart from './daemon_restart';
import * as daemonLog from './daemon_log';
import * as dictation from './dictation';
import * as mobile from './mobile';
import * as peers from './peers';
import * as providerAuth from './provider_auth';
import * as piRuntime from './pi_runtime';
import * as terminals from './terminals';
import * as daemon from './daemon';
import { startSessionBroker } from './broker';
import { loadAppSettings } from './settings';
import { prepareDefinedAgentsExtension } from './extensions';

export async function runDaemon(): Promise<void> {
  const first = process.argv[2];
  if (first === '--daemon-log-writer') return daemonLog.run();
  const special = daemonRestart.specialMode();
  if (special) return special;
  if (first === 'start' || first === 'stop') return daemonStdio.control(first);
  if (first === '--stdio-client') return daemonStdio.run();
  const instance = daemonEndpoint.claim();
  try {
    daemonEndpoint.identity();
    // Hash the executable now, before a rebuild can replace it, so launchers see this process's own build.
    if (DEVELOPMENT) daemonEndpoint.debugRuntime();
    await runBackend();
  } finally { instance.release(); }
}

async function runBackend(): Promise<void> {
  const app = new App();
  dictation.start(app);
  await startSessionBroker(app, app.broker);
  const settings = await loadAppSettings(app);
  await prepareDefinedAgentsExtension();
  await daemon.connect(app, app.pi, app.broker, settings, 'local');
  await daemonRestart.initializeCandidate(app);
  await mobile.start(app);
  await daemonRestart.ready();
  await waitForShutdown(app);
  await shutdownBackend(app);
}

function waitForShutdown(app: App): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    app.clients.waitForShutdown(app).then(finish, finish);
  });
}

async function ignore(operation: () => Promise<unknown> | unknown): Promise<void> {
  try { await operation(); } catch { /* cleanup continues */ }
}

/** Releases every session, terminal and peer route held by one client. */
export async function detachOwner(app: App, owner: string, discardBlank: boolean): Promise<void> {
  await ignore(() => peers.detachOwner(app, owner));
  await ignore(() => providerAuth.cancelOwner(app.pi, owner));
  await ignore(() => piRuntime.detachOwner(app.pi, owner, discardBlank));
  await ignore(() => terminals.detachOwner(app.terminals, owner));
}

async function shutdownBackend(app: App): Promise<void> {
  await ignore(() => peers.shutdown(app));
  await ignore(() => app.broker.shutdown());
  await ignore(() => terminals.shutdown(app.terminals));
  await ignore(() => piRuntime.shutdown(app.pi));
}
