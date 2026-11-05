import * as Registry from './session_registry';
import { parseSession, serializeSession } from './types';
import type { CachedSession } from './session_index';
import type { Database } from './util/db';
import { transaction } from './util/db';

export function load(connection: Database): Map<string, CachedSession> {
  const rows = connection.prepare(`SELECT s.session_id, s.session_path, c.fingerprint, c.modified_at, c.summary_json
        FROM session_sidebar c JOIN sessions s USING(session_id)`).all() as any[];
  const cache = new Map<string, CachedSession>();
  for (const row of rows) {
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

export function save(connection: Database, cache: Map<string, CachedSession>): void {
  transaction(connection, 'IMMEDIATE', () => {
    connection.exec('CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY); DELETE FROM sidebar_seen;');
    const registered = connection.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND session_path=?) AS present');
    const upsert = connection.prepare(`INSERT INTO session_sidebar VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
            fingerprint=excluded.fingerprint, modified_at=excluded.modified_at, summary_json=excluded.summary_json
            WHERE session_sidebar.fingerprint != excluded.fingerprint OR session_sidebar.summary_json != excluded.summary_json`);
    const seen = connection.prepare('INSERT OR IGNORE INTO sidebar_seen VALUES (?)');
    for (const cached of cache.values()) {
      if (cached.blank) continue;
      const summary = cached.summary;
      const value = serializeSession(summary);
      delete value.id; delete value.path;
      const row = registered.get(summary.id, summary.path) as { present: number };
      if (!row.present) continue;
      upsert.run(summary.id, cached.fingerprint, summary.modifiedAt, JSON.stringify(value));
      seen.run(summary.id);
    }
    connection.exec('DELETE FROM session_sidebar WHERE session_id NOT IN (SELECT session_id FROM sidebar_seen)');
  });
}

// The storage root whose saved sidebar was loaded.
export interface SidebarDatabase { root: string }

export function prepare(holder: { database?: SidebarDatabase }, root: string, cache: Map<string, CachedSession>): boolean {
  if (holder.database?.root === root) return false;
  holder.database = undefined;
  try {
    for (const [path, entry] of load(Registry.connection(root))) if (!cache.has(path)) cache.set(path, entry);
    holder.database = { root };
  } catch (error: any) { console.error(`Could not load saved sidebar: ${error.message ?? error}`); }
  return true;
}

export function persist(holder: { database?: SidebarDatabase }, cache: Map<string, CachedSession>): void {
  if (!holder.database) return;
  try { save(Registry.connection(holder.database.root), cache); }
  catch (error: any) {
    console.error(`Could not save sidebar: ${error.message ?? error}`);
    holder.database = undefined;
  }
}
