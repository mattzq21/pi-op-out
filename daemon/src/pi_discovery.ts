import { randomUUID } from 'node:crypto';
import { homeDir } from './environment';
import type { App } from './app';
import { startPiForOwner, stopPi } from './pi_runtime';

/** What a starting Pi reports to its host: its tools and its extension commands. */
export type PiReport = 'tools' | 'commands';

const DISCOVERY_TIMEOUT_MS = 60_000;
const waiters = new Set<(report: PiReport) => void>();
let running: Promise<void> | undefined;

/** Tells a running discovery that Pi sent a report. */
export function reported(report: PiReport): void {
  for (const waiter of [...waiters]) waiter(report);
}

function nextReports(): { reported: Promise<void>; cancel: () => void } {
  const missing = new Set<PiReport>(['tools', 'commands']);
  let waiter!: (report: PiReport) => void;
  let timer!: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((resolve, reject) => {
    waiter = report => { missing.delete(report); if (!missing.size) { cancel(); resolve(); } };
    timer = setTimeout(() => { cancel(); reject(new Error('Pi did not report its ' + [...missing].join(' and ') + ' within ' + DISCOVERY_TIMEOUT_MS / 1000 + ' seconds')); }, DISCOVERY_TIMEOUT_MS);
    waiters.add(waiter);
  });
  const cancel = () => { clearTimeout(timer); waiters.delete(waiter); };
  return { reported: done, cancel };
}

async function run(app: App): Promise<void> {
  const runtimeId = 'pi-discovery-' + randomUUID();
  const report = nextReports();
  try {
    await startPiForOwner(app, 'pi-discovery', app.pi, app.broker, { runtimeId, clientId: runtimeId, hostId: 'local', cwd: homeDir() });
    await report.reported;
  } finally {
    report.cancel();
    await stopPi(app.pi, runtimeId, true);
  }
}

/** Starts a Pi session on this host without a chat, waits until it reports its tools and commands, then stops it. Callers at the same time share one run. */
export function discoverPi(app: App): Promise<void> {
  running ??= run(app).finally(() => { running = undefined; });
  return running;
}
