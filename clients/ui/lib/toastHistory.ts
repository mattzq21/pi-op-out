import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import { mergeToastHistory, syncToastHistory, type ToastHistoryEntry } from "./toastHistoryStorage";

export type { ToastHistoryEntry } from "./toastHistoryStorage";

type Notice = { id: string; title: string; message: string };

/** The history keeps the newest 10 notices, so unsaved notices are limited the same way. */
const HISTORY_LIMIT = 10;

const [toastHistory, setToastHistory] = createSignal<ToastHistoryEntry[]>([]);
/** Why the last history save failed, until a save succeeds. */
const [toastHistoryError, setToastHistoryError] = createSignal<string>();

export { toastHistory, toastHistoryError };

const pending = new Map<string, ToastHistoryEntry>();

const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("piop-notification-history") : undefined;

let saving = false;

let refreshPending = false;

function refreshHistory() {
  if (saving) { refreshPending = true;

  return; }

  saving = true; refreshPending = false;
  const sent = [...pending.values()];
  let succeeded = false;
  void syncToastHistory(sent).then(saved => {
    sent.forEach(entry => pending.delete(entry.id));
    setToastHistory(mergeToastHistory(saved, [...pending.values()]));
    succeeded = true;
    setToastHistoryError(undefined);

    if (sent.length) channel?.postMessage(null);
  }).catch(error => {
    console.error("Could not save notification history", error);
    setToastHistoryError(`Could not save notification history: ${error instanceof Error ? error.message : String(error)}. Recent notifications are only kept in memory. Saving will retry on the next notification or when this window gains focus.`);
  }).finally(() => {
    saving = false;

    if (succeeded && (pending.size || refreshPending)) refreshHistory();
  });
}

if (channel) channel.onmessage = refreshHistory;

window.addEventListener("focus", refreshHistory);

refreshHistory();

function recordToast(source: string, notice: { title: string; message: string }) {
  const entry = { ...notice, source, id: crypto.randomUUID(), timestamp: Date.now() };
  pending.set(entry.id, entry);
  for (const id of pending.keys()) {
    if (pending.size <= HISTORY_LIMIT) break;
    pending.delete(id);
  }
  setToastHistory(mergeToastHistory(untrack(toastHistory), [entry]));
  refreshHistory();
}

export function trackToastNotices(source: string, notices: Accessor<Notice[]>) {
  let previous = new Set<string>();
  createEffect(() => {
    const current = notices();
    const added = current.filter(notice => !previous.has(notice.id));
    previous = new Set(current.map(notice => notice.id));

    for (const notice of added) recordToast(source, { title: notice.title, message: notice.message });
  });
}

export function trackToastMessage(source: string, title: string, message: Accessor<string | undefined>) {
  let previous: string | undefined;
  createEffect(() => {
    const current = message();
    const changed = current !== previous;
    previous = current;

    if (current && changed) recordToast(source, { title, message: current });
  });
}
