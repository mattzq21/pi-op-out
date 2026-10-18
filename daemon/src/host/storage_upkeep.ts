import * as Registry from '../session_registry';
import * as storageTransactions from '../storage_transactions';
import { errorText, sleep } from '../util/sync';
import type { ConversationOwnership } from './ownership';
import { recoverMissingTranscripts, type Recovery } from './queue_recovery';

type Output = (packet: any) => void;

/** Recovers missing transcripts for saved queued input, and retries in the background until done or the host stops. */
export function recoverQueuedInput(root: string, ownership: ConversationOwnership, output: Output): void {
  let recovery = recoverMissingTranscripts(root, ownership);
  const reported = new Set<string>();
  report(recovery, reported, output);
  if (!recovery.retry) return;
  void (async () => {
    let delay = 1000;
    while (recovery.retry && !ownership.stopped) {
      const pending = recovery.transactionsPending;
      try {
        if (recovery.waiting) await recovery.waiting;
        else { await sleep(delay); delay = Math.min(delay * 2, 60_000); }
        if (ownership.stopped) break;
        if (pending) await collectRetention(root);
        recovery = recoverMissingTranscripts(root, ownership);
      } catch (error) {
        recovery = { errors: [errorText(error)], recovered: false, retry: true, transactionsPending: pending };
      }
      if (ownership.stopped) break;
      report(recovery, reported, output);
    }
  })();
}

function report(recovery: Recovery, reported: Set<string>, output: Output): void {
  for (const error of recovery.errors) {
    if (reported.has(error)) continue;
    reported.add(error);
    output({ type: 'diagnostic', line: 'Queued input retained for recovery: ' + error });
  }
  if (recovery.recovered) output({ type: 'sessions_changed' });
}

/** Runs deferred retention cleanup now and every 30 seconds until the host stops. Returns the timer. */
export function watchRetention(root: string, ownership: ConversationOwnership, output: Output): NodeJS.Timeout {
  let reported: string | null = null;
  let initialized = false;
  let running = false;
  const pass = async () => {
    if (running || ownership.stopped) return;
    running = true;
    try {
      await retentionPass(root, !initialized);
      initialized = true;
      reported = null;
    } catch (error) {
      const message = errorText(error);
      if (reported !== message) output({ type: 'diagnostic', line: 'Deferred retention cleanup is pending: ' + message });
      reported = message;
    } finally { running = false; }
  };
  void pass();
  const timer = setInterval(() => { void pass(); }, 30_000);
  timer.unref();
  return timer;
}

async function retentionPass(root: string, initialize: boolean): Promise<void> {
  if (initialize) Registry.requestCleanup(root, 'goal');
  if (!Registry.pending(root, 'retention')) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Deferred retention cleanup timed out; candidates remain available for retry')), 30_000); });
  const controller = new AbortController();
  try { await Promise.race([collectRetention(root, controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

function collectRetention(root: string, signal?: AbortSignal): Promise<void> {
  return storageTransactions.recover({ root, signal, busyIsOk: true });
}
