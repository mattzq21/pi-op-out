/** A duration as "5s", "2min 3s" or "1h 4min". */
export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}min` : ""}`;

  if (minutes > 0) return `${minutes}min${seconds > 0 ? ` ${seconds}s` : ""}`;

  return `${seconds}s`;
}

/** The time from start to end, rounded to whole seconds and at least 1s, as "Worked for" shows it. Empty when a time is missing. */
export function formatElapsed(startedAt?: number, endedAt?: number) {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return "";

  return formatDuration(Math.max(1, Math.round((endedAt - startedAt) / 1000)) * 1000);
}
