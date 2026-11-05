import path from 'node:path';
import { connection, transaction } from './core.ts';

export interface LocalSessionRow { path: string; revision: number }

export interface SidebarSummaryRow { session_id: string; session_path: string; revision: number; modified_at: number; summary_json: string }

export interface SidebarSummary { id: string; path: string; revision: number; modifiedAt: number; json: string }

export interface SdkSessionListRow { session_id: string; session_path: string }


// The registered transcripts of a storage folder, and their saved sidebar summaries.

// The active sessions under a sessions folder (by its given or resolved path).
function localSessionRows(root: string, prefix: string, resolved: string): LocalSessionRow[] {
  return connection(root).prepare(`SELECT s.session_path AS path, s.revision FROM sessions s
    WHERE s.archived=0 AND (substr(s.session_path, 1, length(?1))=?1 OR substr(s.session_path, 1, length(?2))=?2)`).all(prefix, resolved) as unknown as LocalSessionRow[];
}

// The saved sidebar summaries of registered sessions.
function sidebarSummaries(root: string): SidebarSummaryRow[] {
  return connection(root).prepare(`SELECT s.session_id, s.session_path, c.revision, c.modified_at, c.summary_json
    FROM session_sidebar c JOIN sessions s USING(session_id)`).all() as unknown as SidebarSummaryRow[];
}

// Replaces the saved sidebar with summaries ({ id, path, revision, modifiedAt, json }) of sessions that are registered.
function replaceSidebarSummaries(root: string, summaries: Iterable<SidebarSummary>): void {
  transaction(root, 'IMMEDIATE', () => {
    const db = connection(root);
    db.exec('CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY); DELETE FROM sidebar_seen;');
    const registered = db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND session_path=?) AS present');
    const upsert = db.prepare(`INSERT INTO session_sidebar VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      revision=excluded.revision, modified_at=excluded.modified_at, summary_json=excluded.summary_json
      WHERE session_sidebar.revision != excluded.revision OR session_sidebar.summary_json != excluded.summary_json`);
    const seen = db.prepare('INSERT OR IGNORE INTO sidebar_seen VALUES (?)');

    for (const summary of summaries) {
      if (!(registered.get(summary.id, summary.path) as { present: number }).present) continue;
      upsert.run(summary.id, summary.revision, summary.modifiedAt, summary.json);
      seen.run(summary.id);
    }

    db.exec('DELETE FROM session_sidebar WHERE session_id NOT IN (SELECT session_id FROM sidebar_seen)');
  });
}

// The active registered sessions in a folder (and its subfolders when recursive), for the SDK chat list.
function sdkSessionListRows(root: string, directory: string, recursive: boolean): SdkSessionListRow[] {
  const prefix = directory + path.sep;

  return connection(root).prepare(`SELECT s.session_id, s.session_path FROM sessions s
    WHERE s.archived=0 AND substr(s.session_path, 1, length(?))=?
    AND (? OR instr(substr(s.session_path, length(?) + 1), ?)=0)`)
    .all(prefix, prefix, Number(recursive), prefix, path.sep) as unknown as SdkSessionListRow[];
}

// The saved text of a Pi settings file, or undefined.
function sdkSettingsText(root: string, file: string): string | undefined {
  return (connection(root).prepare('SELECT body FROM sdk_settings WHERE path=?').get(file) as { body: string | null } | undefined)?.body ?? undefined;
}

export { localSessionRows, sidebarSummaries, replaceSidebarSummaries, sdkSessionListRows, sdkSettingsText };
