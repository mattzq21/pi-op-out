import { recoverChatWorktrees, sweepDeletedSessions } from './archives';
import { App } from './app';
import { DEVELOPMENT } from './config';
import * as daemonEndpoint from './daemon_endpoint';
import * as daemonStdio from './daemon_stdio';
import * as daemonRestart from './daemon_restart';
import * as daemonLog from './daemon_log';
import * as clientServer from './client_server';
import * as peers from './peers';
import * as providerAuth from './provider_auth';
import * as piRuntime from './pi_runtime';
import * as terminals from './terminals';
import { startLocalHost, stopLocalHost } from './local_host';
import { resumeInterruptedTasks } from './interrupted_tasks';
import { stopOrphanedProcesses } from './process_cleanup';
import { loadAppSettings } from './settings';
import { generatedExtensions, removeUnusedGeneratedExtensions } from './extensions';
import { errorText } from './util/sync';
import { shutdownHostOperations } from './host_operations';
import { startTray } from './tray';

let failureListener: ((line: string) => void) | undefined;

export function installFailureHandlers(): void {
  const report = (kind: string, error: unknown) => {
    const line = kind + ' in the Piop daemon: ' + errorText(error) + (error instanceof Error && error.stack ? '\n' + error.stack : '');
    console.error(line);
    try { failureListener?.(line); } catch (reason) { console.error('Could not report the daemon failure to clients: ' + errorText(reason)); }
  };
  process.on('unhandledRejection', error => report('Unhandled promise rejection', error));
  process.on('uncaughtException', error => report('Uncaught exception', error));
}

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
    if (DEVELOPMENT) daemonEndpoint.debugRuntime();
    await runBackend();
  } finally { instance.release(); }
}

async function runBackend(): Promise<void> {
  const app = new App();
  failureListener = line => app.emit('pi://daemon-error', { hostId: 'local', line });
  const signalled = watchSignals(app);
  const stoppedEarly = Symbol('stopped during startup');
  const step = async (operation: () => Promise<unknown> | unknown) => { if (app.clients.closing()) throw stoppedEarly; await operation(); };
  let removeTray = () => {};
  try {
    let settings: Awaited<ReturnType<typeof loadAppSettings>> | undefined;
    let orphansStopped = false;
    await step(async () => { orphansStopped = await stopOrphanedProcesses(); });
    await step(() => daemonRestart.adoptCandidatePlan());
    await step(() => sweepDeletedSessions(app));
    await step(() => recoverChatWorktrees(app));
    await step(async () => { settings = await loadAppSettings(app); });
    await step(() => startLocalHost(app, settings!));
    await step(() => prepareExtensions(orphansStopped));
    await step(() => daemonRestart.initializeCandidate(app));
    await step(() => clientServer.start(app));
    await step(() => app.usage.start(app, settings!.hiddenUsageIndicators));
    await step(() => daemonRestart.ready());
    void resumeInterruptedTasks(app).catch(error => {
      const line = 'Could not start again the interrupted tasks: ' + errorText(error);
      console.error(line);
      app.emit('pi://daemon-error', { hostId: 'local', line });
    });
    await step(async () => { removeTray = await startTray(() => app.clients.stop()); });
    await Promise.race([signalled.stopped, app.clients.waitForShutdown(app).catch(error => console.error('Shutdown wait failed:', error))]);
  } catch (error) {
    if (error !== stoppedEarly) throw error;
  } finally {
    try { removeTray(); await shutdownBackend(app); }
    finally {
      signalled.release();
      failureListener = undefined;
    }
  }
}

function prepareExtensions(orphansStopped: boolean): void {
  try {
    generatedExtensions();
    if (orphansStopped) removeUnusedGeneratedExtensions();
  } catch (error) { console.error('Could not prepare the Pi extensions: ' + errorText(error)); }
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function watchSignals(app: App): { stopped: Promise<void>; release(): void } {
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  let received = false;
  const finish = (signal: NodeJS.Signals) => {
    if (received) { console.error('Piop daemon received ' + signal + ' while shutting down; shutdown continues'); return; }
    received = true;
    console.error('Piop daemon received ' + signal + '; shutting down');
    app.clients.stop();
    resolveStopped();
  };
  for (const signal of STOP_SIGNALS) process.on(signal, finish);
  return { stopped, release: () => { for (const signal of STOP_SIGNALS) process.off(signal, finish); } };
}

async function ignore(operation: () => Promise<unknown> | unknown): Promise<void> {
  try { await operation(); } catch (error) { console.error('Daemon cleanup failed:', error); }
}

export async function detachOwner(app: App, owner: string, discardBlank: boolean): Promise<void> {
  const remote = ignore(() => peers.detachOwner(app, owner));
  await ignore(() => providerAuth.cancelOwner(app.pi, owner));
  await ignore(() => piRuntime.detachOwner(app.pi, owner, discardBlank));
  await ignore(() => terminals.detachOwner(app.terminals, owner));
  await remote;
}

async function shutdownBackend(app: App): Promise<void> {
  app.clients.stop();
  const usage = app.usage.stop();
  clientServer.stopAccepting(app);
  await ignore(() => app.clients.drain(10_000));
  clientServer.closeConnections(app);
  await ignore(() => clientServer.unpublish(app));
  await ignore(() => peers.shutdown(app));
  await ignore(() => app.broker.shutdown());
  await ignore(() => terminals.shutdown(app.terminals));
  await ignore(() => stopLocalHost(app));
  await ignore(() => shutdownHostOperations());
  await usage;
}
