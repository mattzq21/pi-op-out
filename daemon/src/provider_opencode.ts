import { piExecutable } from './environment';
import { resolveProviderAuth } from './host/index';

export interface UsageWindow { status: string; remainingPercent: number; resetAt?: number }
export interface OpencodeGoUsage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow }

function epochSeconds(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d*)?[Zz]/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const seconds = Date.UTC(year, month - 1, 1, hour, minute, second) / 1000 + (day - 1) * 86400;
  return seconds >= 0 ? seconds : undefined;
}

function usageWindow(window: any): UsageWindow | undefined {
  const percent = window?.percent;
  if (typeof percent !== 'number') return undefined;
  const result: UsageWindow = { status: typeof window.status === 'string' ? window.status : 'ok', remainingPercent: Math.round(100 - Math.min(100, Math.max(0, percent))) };
  const reset = typeof window.resetsAt === 'string' ? epochSeconds(window.resetsAt) : undefined;
  if (reset !== undefined) result.resetAt = reset;
  return result;
}

export function opencodeGoUsageValues(response: any): OpencodeGoUsage | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  const rolling = usageWindow(usage.rolling); const weekly = usageWindow(usage.weekly); const monthly = usageWindow(usage.monthly);
  if (!rolling || !weekly || !monthly) return undefined;
  return { rolling, weekly, monthly };
}

export async function opencodeGoUsage(): Promise<OpencodeGoUsage> {
  const auth = await resolveProviderAuth(piExecutable(), 'opencode-go');
  const apiKey = auth?.apiKey;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('OpenCode Go API key is not configured');
  const headers: Record<string, string> = { Authorization: 'Bearer ' + apiKey };
  for (const [name, value] of Object.entries(auth?.headers ?? {})) {
    if (typeof value !== 'string') throw new Error('Invalid OpenCode Go authentication header');
    headers[name] = value;
  }
  let response: Response;
  try { response = await fetch('https://opencode.ai/zen/go/v1/usage', { headers, signal: AbortSignal.timeout(8000) }); }
  catch (error: any) { throw new Error('OpenCode Go usage request failed: ' + (error?.message ?? error)); }
  if (!response.ok) {
    let message = response.status + ' ' + response.statusText;
    try { const body: any = await response.json(); if (typeof body?.error?.message === 'string') message = body.error.message; } catch {}
    throw new Error('OpenCode Go usage is unavailable: ' + message);
  }
  let body: any;
  try { body = await response.json(); } catch (error: any) { throw new Error('OpenCode Go usage could not be read: ' + (error?.message ?? error)); }
  const usage = opencodeGoUsageValues(body);
  if (!usage) throw new Error('OpenCode Go usage is unavailable');
  return usage;
}
