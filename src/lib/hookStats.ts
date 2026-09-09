export const HOOK_STATS_KEY = "pi-desktop-hook-stats";
export interface HookCounts { completed: number; failed: number }
export interface HookStats { other: HookCounts; messages: Record<string, HookCounts> }
export function messageHookCounts(messages: { role: string; timestamp?: number }[], stats?: HookStats): HookCounts | undefined {
  if (!stats) return;
  const keys = new Set(messages.filter((message) => message.role === "user").map((message) => String(message.timestamp)));
  const counts = [...keys].flatMap((key) => stats.messages[key] ? [stats.messages[key]] : []);
  if (!counts.length) return;
  return counts.reduce((total, item) => ({ completed: total.completed + item.completed, failed: total.failed + item.failed }), { completed: 0, failed: 0 });
}
export function parseHookStats(text?: string): HookStats | undefined {
  if (!text?.startsWith("json:")) return;
  try {
    const value = JSON.parse(text.slice(5));
    const valid = (counts: HookCounts) => counts && Number.isSafeInteger(counts.completed) && Number.isSafeInteger(counts.failed) && counts.failed >= 0 && counts.completed >= counts.failed;
    if (valid(value?.other) && value.messages && typeof value.messages === "object" && !Array.isArray(value.messages) && Object.values(value.messages).every((counts) => valid(counts as HookCounts))) return value;
  } catch { /* Ignore incompatible extension data. */ }
}
