const two = (value: number) => String(value).padStart(2, "0");

export function formatTime(date: Date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function formatDayTime(date: Date) {
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${formatTime(date)}`;
}

export function formatDateTime(date: Date) {
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ${formatTime(date)}`;
}
