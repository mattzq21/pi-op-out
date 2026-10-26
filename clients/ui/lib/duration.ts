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
