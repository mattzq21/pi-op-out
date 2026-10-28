const two = (value: number) => String(value).padStart(2, "0");

/** Local time as "HH:mm", 24h. */
export function formatTime(date: Date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Local date and time as "dd/mm HH:mm". */
export function formatDayTime(date: Date) {
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${formatTime(date)}`;
}

/** Local date and time as "dd/mm/yyyy HH:mm". */
export function formatDateTime(date: Date) {
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ${formatTime(date)}`;
}
