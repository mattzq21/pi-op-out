import { replaceSidebarSummaries, sidebarSummaries, type SidebarSummary } from '../resources/session-database.cjs';
import { parseSession, serializeSession } from './types';
import type { CachedSession } from './session_index';

export function load(root: string): Map<string, CachedSession> {
  const cache = new Map<string, CachedSession>();
  for (const row of sidebarSummaries(root)) {
    let value: any;
    try { value = JSON.parse(row.summary_json); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    value.id = row.session_id; value.path = row.session_path;
    let summary;
    try { summary = parseSession(value); } catch { continue; }
    summary.modifiedAt = Number(row.modified_at);
    cache.set(row.session_path, { fingerprint: row.fingerprint, summary });
  }
  return cache;
}

export function save(root: string, cache: Map<string, CachedSession>): void {
  const summaries: SidebarSummary[] = [];
  for (const cached of cache.values()) {
    if (cached.blank) continue;
    const summary = cached.summary;
    const value = serializeSession(summary);
    delete value.id; delete value.path;
    summaries.push({ id: summary.id, path: summary.path, fingerprint: cached.fingerprint, modifiedAt: summary.modifiedAt, json: JSON.stringify(value) });
  }
  replaceSidebarSummaries(root, summaries);
}

// The storage root whose saved sidebar was loaded.
export interface SidebarDatabase { root: string }

export function prepare(holder: { database?: SidebarDatabase }, root: string, cache: Map<string, CachedSession>): boolean {
  if (holder.database?.root === root) return false;
  holder.database = undefined;
  try {
    for (const [path, entry] of load(root)) if (!cache.has(path)) cache.set(path, entry);
    holder.database = { root };
  } catch (error: any) { console.error(`Could not load saved sidebar: ${error.message ?? error}`); }
  return true;
}

export function persist(holder: { database?: SidebarDatabase }, cache: Map<string, CachedSession>): void {
  if (!holder.database) return;
  try { save(holder.database.root, cache); }
  catch (error: any) {
    console.error(`Could not save sidebar: ${error.message ?? error}`);
    holder.database = undefined;
  }
}
