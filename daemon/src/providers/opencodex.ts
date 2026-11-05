import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homeDir, isDirectory } from '../environment';

export interface OpencodexAccount { id: string; remainingPercent?: number; resetAt?: number; error?: string }
export interface OpencodexUsage { accounts: OpencodexAccount[]; unavailable?: true }

function accountUsage(account: any): OpencodexAccount | undefined {
  const id = account?.upstreamAccountKey;
  if (typeof id !== 'string' || !id) return undefined;
  if (account.needsReauth === true) return { id, error: 'This account needs a new login in OCX' };
  const used = account.quota?.weeklyPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return { id, error: typeof account.quotaRefresh?.error === 'string' ? account.quotaRefresh.error : 'OCX has no weekly usage for this account' };
  const usage: OpencodexAccount = { id, remainingPercent: Math.round(100 - Math.min(100, Math.max(0, used))) };
  const reset = account.quota.weeklyResetAt;
  if (Number.isInteger(reset) && reset >= 0) usage.resetAt = reset;
  return usage;
}

export function opencodexUsageValues(response: any): OpencodexUsage | undefined {
  if (!Array.isArray(response?.accounts)) return undefined;
  const accounts = new Map<string, OpencodexAccount>();
  for (const entry of response.accounts) {
    if (entry?.type !== 'codex') continue;
    const usage = accountUsage(entry);
    if (!usage) continue;
    const known = accounts.get(usage.id);
    if (!known || (known.remainingPercent === undefined && usage.remainingPercent !== undefined)) accounts.set(usage.id, usage);
  }
  return { accounts: [...accounts.values()] };
}

export async function opencodexUsage(): Promise<OpencodexUsage | undefined> {
  const home = homeDir();
  if (!isDirectory(join(home, '.opencodex'))) return undefined;
  const output = await new Promise<string | undefined>((resolve, reject) => {
    execFile('ocx', ['account', 'list', 'openai', '--quota', '--refresh', '--json'], { cwd: home, timeout: 20_000, maxBuffer: 4 << 20 }, (error: any, stdout, stderr) => {
      if (error?.code === 'ENOENT') { resolve(undefined); return; }
      if (error) { reject(new Error('OCX usage is unavailable: ' + (String(stderr).trim().split('\n')[0] || (error.killed ? 'request timed out' : error.message)))); return; }
      resolve(stdout);
    });
  });
  if (output === undefined) return { accounts: [], unavailable: true };
  let body: unknown;
  try { body = JSON.parse(output); } catch { throw new Error('OCX usage could not be read'); }
  const usage = opencodexUsageValues(body);
  if (!usage) throw new Error('OCX usage could not be read');
  return usage.accounts.length ? usage : undefined;
}
