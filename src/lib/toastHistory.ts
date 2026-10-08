import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import { z } from "zod";

const storageKey = "piop.toast-history";

const entriesSchema = z.array(z.object({
  id: z.string(), timestamp: z.number().min(0).max(8.64e15), source: z.string(), title: z.string(), message: z.string(),
}));

export type ToastHistoryEntry = z.infer<typeof entriesSchema>[number];

type Notice = { id: string; title: string; message: string };

function readHistory(fallback: ToastHistoryEntry[] = []): ToastHistoryEntry[] {
  try { return entriesSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).slice(-10); }
  catch { return fallback; }
}

const [toastHistory, setToastHistory] = createSignal(readHistory());

export { toastHistory };

window.addEventListener("storage", event => {
  if (event.key === storageKey) setToastHistory(readHistory());
});

function recordToast(source: string, notice: { title: string; message: string }) {
  const previous = readHistory(untrack(toastHistory));
  const next = [...previous.slice(-9), { ...notice, source, id: crypto.randomUUID(), timestamp: Date.now() }];
  setToastHistory(next);

  try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { }
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
