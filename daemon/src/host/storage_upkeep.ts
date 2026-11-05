import * as Registry from '../session_registry';
import * as storageTransactions from '../storage_transactions';
import { errorText, sleep } from '../util/sync';
import type { ConversationOwnership } from './ownership';
import { recoverMissingTranscripts, type Recovery } from './queue_recovery';
import type { HostEvents } from './events';
import { collectRetentionWith } from '../retention_requests';

export function recoverQueuedInput(root: string, ownership: ConversationOwnership, events: HostEvents): void {
  let recovery = recoverMissingTranscripts(root, ownership);
  const reported = new Set<string>();
  report(recovery, reported, events);
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
      report(recovery, reported, events);
    }
  })();
}

function report(recovery: Recovery, reported: Set<string>, events: HostEvents): void {
  for (const error of recovery.errors) {
    if (reported.has(error)) continue;
    reported.add(error);
    events.diagnostic('Queued input retained for recovery: ' + error);
  }
  if (recovery.recovered) events.sessionsChanged();
}

// Collects deferred cleanup at start, and again each time the storage changes in a way that can free it: a
// deletion of chats or the end of a goal's preparation. A failed pass is tried again later.
export function watchRetention(root: string, ownership: ConversationOwnership, events: HostEvents): () => void {
  let reported: string | null = null;
  let initialized = false;
  let running = false;
  let again = false;
  let failures = 0;
  let retry: NodeJS.Timeout | undefined;
  const pass = async () => {
    if (ownership.stopped) return;
    if (running) { again = true; return; }
    running = true;
    clearTimeout(retry);
    retry = undefined;
    try {
      await retentionPass(root, !initialized);
      initialized = true;
      reported = null;
      failures = 0;
    } catch (error) {
      const message = errorText(error);
      if (reported !== message) events.diagnostic('Deferred retention cleanup is pending: ' + message);
      reported = message;
      retry = setTimeout(() => { void pass(); }, Math.min(1000 * 2 ** failures++, 300_000));
      retry.unref();
    } finally { running = false; }
    if (again) { again = false; void pass(); }
  };
  const remove = collectRetentionWith(root, () => { void pass(); });
  void pass();
  return () => { clearTimeout(retry); remove(); };
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
