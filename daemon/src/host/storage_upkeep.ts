import * as Registry from '../session_registry';
import { errorText, sleep } from '../util/sync';
import type { ConversationOwnership } from './ownership';
import { recoverMissingTranscripts, type Recovery } from './queue';
import type { HostEvents } from './events';
import { collectRetentionWith } from '../storage';
import * as SessionLifecycle from '../storage/lifecycle.ts';

export function recoverQueuedInput(root: string, ownership: ConversationOwnership, events: HostEvents): void {
  report(recoverMissingTranscripts(root, ownership), events);
}

function report(recovery: Recovery, events: HostEvents): void {
  for (const error of recovery.errors) events.diagnostic('Queued input retained for recovery: ' + error);
  if (recovery.recovered) events.sessionsChanged();
}

// Collects deferred cleanup at start, and again each time the storage changes in a way that can free it: a
// deletion of chats. A failed pass is tried again later.
export function watchRetention(root: string, ownership: ConversationOwnership, events: HostEvents): () => void {
  let reported: string | null = null;
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
      await retentionPass(root);
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

async function retentionPass(root: string): Promise<void> {
  if (!Registry.cleanupPending(root)) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Deferred retention cleanup timed out; candidates remain available for retry')), 30_000); });
  const controller = new AbortController();
  try { await Promise.race([collectRetention(root, controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function collectRetention(root: string, signal?: AbortSignal): Promise<void> {
  await SessionLifecycle.maintain({ root, signal });
}
