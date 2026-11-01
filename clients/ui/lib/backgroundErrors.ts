type Notice = { title: string; message: string };

let show: ((notice: Notice) => void) | undefined;

const waiting: Notice[] = [];

export function reportBackgroundError(title: string, reason: unknown) {
  console.error(title, reason);
  const notice = { title, message: reason instanceof Error ? reason.message : String(reason) };

  if (show) show(notice);
  else { waiting.push(notice); waiting.splice(0, Math.max(0, waiting.length - 10)); }
}

export function showBackgroundErrors(next: (notice: Notice) => void) {
  show = next;

  for (const notice of waiting.splice(0)) next(notice);

  return () => { if (show === next) show = undefined; };
}
