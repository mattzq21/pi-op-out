import { resolveProviderAuth } from './host/index';

export interface AnthropicUsage { remainingPercent: number; resetAt?: number }

export function anthropicUsageValues(response: any): AnthropicUsage | undefined {
  let best: [number, number | undefined] | undefined;
  for (const name of ['five_hour', 'seven_day']) {
    const window = response?.[name];
    const used = window?.utilization;
    if (typeof used !== 'number') continue;
    const parsed = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    const reset = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed / 1000) : undefined;
    if (!best || used >= best[0]) best = [used, reset];
  }
  if (!best) return undefined;
  const usage: AnthropicUsage = { remainingPercent: Math.round(100 - Math.min(100, Math.max(0, best[0]))) };
  if (best[1] !== undefined) usage.resetAt = best[1];
  return usage;
}

export async function anthropicUsage(): Promise<AnthropicUsage | undefined> {
  const auth = await resolveProviderAuth('anthropic');
  if (auth === null) return undefined;
  const token = auth?.apiKey;
  if (typeof token !== 'string' || !token.trim()) throw new Error('Anthropic login is not configured');
  if (token.startsWith('sk-ant-api')) throw new Error('Anthropic usage needs a Claude subscription login');
  let response: Response;
  try { response = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) }); }
  catch (error: any) { throw new Error('Anthropic usage request failed: ' + (error?.message ?? error)); }
  if (!response.ok) {
    let message = response.status + ' ' + response.statusText;
    try { const body: any = await response.json(); if (typeof body?.error?.message === 'string') message = body.error.message; } catch {}
    throw new Error('Anthropic usage is unavailable: ' + message);
  }
  let body: any;
  try { body = await response.json(); } catch (error: any) { throw new Error('Anthropic usage could not be read: ' + (error?.message ?? error)); }
  const usage = anthropicUsageValues(body);
  if (!usage) throw new Error('Anthropic usage is unavailable');
  return usage;
}
