type Notice = { title: string; message: string; key?: string };

type Sink = { show: (notice: Notice) => void; clear: (key: string) => void };

let sink: Sink | undefined;

const waiting: Notice[] = [];

const latestAttempts = new Map<string, number>();

const dropWaiting = (key: string) => { for (let index = waiting.length - 1; index >= 0; index--) if (waiting[index].key === key) waiting.splice(index, 1); };

export function reportBackgroundError(title: string, reason: unknown, key?: string) {
  console.error(title, reason);
  const notice = { title, message: reason instanceof Error ? reason.message : String(reason), ...(key === undefined ? {} : { key }) };

  if (sink) { sink.show(notice); return; }
  if (key !== undefined) dropWaiting(key);
  waiting.push(notice); waiting.splice(0, Math.max(0, waiting.length - 10));
}

export function clearBackgroundError(key: string) {
  if (sink) sink.clear(key); else dropWaiting(key);
}

export function backgroundAttempt(key: string, title: string) {
  const attempt = (latestAttempts.get(key) ?? 0) + 1;
  latestAttempts.set(key, attempt);
  const latest = () => latestAttempts.get(key) === attempt;

  return {
    succeeded() { if (!latest()) return false; clearBackgroundError(key); return true; },
    failed(reason: unknown) { if (!latest()) return false; reportBackgroundError(title, reason, key); return true; },
  };
}

export function showBackgroundErrors(next: Sink) {
  sink = next;

  for (const notice of waiting.splice(0)) next.show(notice);

  return () => { if (sink === next) sink = undefined; };
}
