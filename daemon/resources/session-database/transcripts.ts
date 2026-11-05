import path from 'node:path';
import { connection, transaction } from './core.ts';

export interface LocalSessionRow {
  path: string; modified: string | number | bigint | null; size: number | null; name: string | null;
  branch_session: string | null; branch_tip: string | null; branch_leaf: string | null;
}

export interface SidebarSummaryRow { session_id: string; session_path: string; fingerprint: string; modified_at: number; summary_json: string }

export interface SidebarSummary { id: string; path: string; fingerprint: string; modifiedAt: number; json: string }

export interface SdkSessionListRow {
  session_id: string; session_path: string; modified_ns: string | number | bigint | null; size: number | null;
  fingerprint: string | null; body: string | null;
}


// Transcript caches: file metadata, sidebar and chat list summaries, saved references and mailbox receipts.

// The registered sessions under a sessions folder (by its given or resolved path), with their saved file metadata, name and
// branch selection.
function localSessionRows(root: string, prefix: string, resolved: string): LocalSessionRow[] {
  return connection(root).prepare(`SELECT s.session_path AS path, m.modified_ns AS modified, m.size AS size, n.name AS name, b.session_id AS branch_session, b.tip_id AS branch_tip, b.leaf_id AS branch_leaf FROM sessions s LEFT JOIN session_branch_selection b ON b.session_id=s.session_id LEFT JOIN session_names n ON n.session_id=s.session_id LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path WHERE substr(s.session_path, 1, length(?1))=?1 OR substr(s.session_path, 1, length(?2))=?2`).all(prefix, resolved) as unknown as LocalSessionRow[];
}

// Saves the file metadata of a transcript that has none yet and that no write is in progress for.
function captureSessionFileMetadata(root: string, file: string, modified: string, size: number): void {
  connection(root).prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_file_writes w WHERE w.session_id=sessions.session_id)
    ON CONFLICT(session_id) DO NOTHING`).run(modified, size, file);
}

// Removes the file metadata of a transcript and marks it as being written.
function forgetSessionFileMetadata(root: string, file: string): void {
  transaction(root, 'IMMEDIATE', () => {
    const db = connection(root);
    db.prepare('DELETE FROM session_file_metadata WHERE session_path=?').run(file);
    db.prepare('INSERT INTO session_file_writes SELECT session_id FROM sessions WHERE session_path=? ON CONFLICT DO NOTHING').run(file);
  });
}

// Saves the file metadata of a transcript that has just been written.
function saveSessionFileMetadata(root: string, file: string, modified: string, size: number | bigint): void {
  transaction(root, 'IMMEDIATE', () => {
    const db = connection(root);
    db.prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
      ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size`)
      .run(modified, size, file);
    db.prepare('DELETE FROM session_file_writes WHERE session_id IN (SELECT session_id FROM sessions WHERE session_path=?)').run(file);
  });
}

// The saved sidebar summaries of registered sessions.
function sidebarSummaries(root: string): SidebarSummaryRow[] {
  return connection(root).prepare(`SELECT s.session_id, s.session_path, c.fingerprint, c.modified_at, c.summary_json
    FROM session_sidebar c JOIN sessions s USING(session_id)`).all() as unknown as SidebarSummaryRow[];
}

// Replaces the saved sidebar with summaries ({ id, path, fingerprint, modifiedAt, json }) of sessions that are registered.
function replaceSidebarSummaries(root: string, summaries: Iterable<SidebarSummary>): void {
  transaction(root, 'IMMEDIATE', () => {
    const db = connection(root);
    db.exec('CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY); DELETE FROM sidebar_seen;');
    const registered = db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND session_path=?) AS present');
    const upsert = db.prepare(`INSERT INTO session_sidebar VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      fingerprint=excluded.fingerprint, modified_at=excluded.modified_at, summary_json=excluded.summary_json
      WHERE session_sidebar.fingerprint != excluded.fingerprint OR session_sidebar.summary_json != excluded.summary_json`);
    const seen = db.prepare('INSERT OR IGNORE INTO sidebar_seen VALUES (?)');

    for (const summary of summaries) {
      if (!(registered.get(summary.id, summary.path) as { present: number }).present) continue;
      upsert.run(summary.id, summary.fingerprint, summary.modifiedAt, summary.json);
      seen.run(summary.id);
    }

    db.exec('DELETE FROM session_sidebar WHERE session_id NOT IN (SELECT session_id FROM sidebar_seen)');
  });
}

// The saved storage report summary of a transcript with this fingerprint, or undefined.
function storageTranscriptSummary(root: string, file: string, stamp: string): Uint8Array | undefined {
  return (connection(root).prepare('SELECT body FROM storage_transcript_summaries WHERE session_path=? AND fingerprint=?').get(file, stamp) as { body: Uint8Array } | undefined)?.body;
}

function saveStorageTranscriptSummary(root: string, file: string, stamp: string, body: Uint8Array): void {
  connection(root).prepare('INSERT INTO storage_transcript_summaries VALUES (?, ?, ?) ON CONFLICT(session_path) DO UPDATE SET fingerprint=excluded.fingerprint, body=excluded.body')
    .run(file, stamp, body);
}

// The saved reference entries (JSON) of a transcript with this fingerprint, or undefined.
function transcriptReferenceEntries(root: string, file: string, stamp: string): string | undefined {
  return (connection(root).prepare('SELECT entries_json FROM transcript_references WHERE session_path=? AND fingerprint=? AND format_version=2').get(file, stamp) as { entries_json: string } | undefined)?.entries_json;
}

function saveTranscriptReference(root: string, file: string, sessionId: string | null, stamp: string, entriesJson: string): void {
  connection(root).prepare('INSERT INTO transcript_references VALUES (?, ?, ?, ?, 2) ON CONFLICT(session_path) DO UPDATE SET session_id=excluded.session_id, fingerprint=excluded.fingerprint, entries_json=excluded.entries_json, format_version=2')
    .run(file, sessionId, stamp, entriesJson);
}

// Moves the saved references from fingerprint previous to stamp and adds the entry (JSON) when there is one. False when the
// saved references do not have fingerprint previous.
function appendTranscriptReference(root: string, file: string, previous: string, stamp: string, entryJson: string | undefined): boolean {
  const db = connection(root);

  if (entryJson !== undefined) return Boolean(db.prepare("UPDATE transcript_references SET fingerprint=?, entries_json=json_insert(entries_json, '$[#]', json(?)) WHERE session_path=? AND fingerprint=? AND format_version=2")
    .run(stamp, entryJson, file, previous).changes);

  return Boolean(db.prepare('UPDATE transcript_references SET fingerprint=? WHERE session_path=? AND fingerprint=? AND format_version=2').run(stamp, file, previous).changes);
}

// Saves the mailbox deliveries (JSON) that a registered transcript received.
function saveMailboxReceipts(root: string, sessionId: string, file: string, fingerprint: string, deliveriesJson: string): void {
  connection(root).prepare(`INSERT INTO session_mailbox_receipt_cache
    SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path,
      fingerprint=excluded.fingerprint, deliveries_json=excluded.deliveries_json`)
    .run(fingerprint, deliveriesJson, sessionId, file);
}

// Moves the saved mailbox receipts from fingerprint previous to fingerprint and adds the delivery (JSON) when there is one.
// False when the saved receipts do not have fingerprint previous.
function appendMailboxReceipts(root: string, sessionId: string, file: string, previous: string, fingerprint: string, deliveryJson: string | undefined): boolean {
  const update = deliveryJson !== undefined ? "json_insert(deliveries_json, '$[#]', json(?))" : 'deliveries_json';
  const values = deliveryJson !== undefined ? [fingerprint, deliveryJson] : [fingerprint];

  return Boolean(connection(root).prepare(`UPDATE session_mailbox_receipt_cache SET fingerprint=?, deliveries_json=${update}
    WHERE session_id=? AND session_path=? AND fingerprint=?`).run(...values, sessionId, file, previous).changes);
}

// Removes the saved references and storage report summaries of the transcripts in a folder.
function removeTranscriptCachesUnder(root: string, directory: string): void {
  const prefix = directory + path.sep;
  const db = connection(root);

  for (const table of ['transcript_references', 'storage_transcript_summaries']) {
    db.prepare(`DELETE FROM ${table} WHERE substr(session_path, 1, length(?))=?`).run(prefix, prefix);
  }
}

// The registered sessions in a folder (and its subfolders when recursive) with their file metadata and saved chat list summary.
function sdkSessionListRows(root: string, directory: string, recursive: boolean): SdkSessionListRow[] {
  const prefix = directory + path.sep;

  return connection(root).prepare(`SELECT s.session_id, s.session_path, m.modified_ns, m.size, c.fingerprint, c.body
    FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path
    LEFT JOIN sdk_session_summaries c ON c.session_id=s.session_id AND c.session_path=s.session_path
    WHERE substr(s.session_path, 1, length(?))=?
    AND (? OR instr(substr(s.session_path, length(?) + 1), ?)=0)`)
    .all(prefix, prefix, Number(recursive), prefix, path.sep) as unknown as SdkSessionListRow[];
}

// Saves the chat list summary (JSON) of a registered transcript.
function saveSdkSessionSummary(root: string, sessionId: string, file: string, stamp: string, body: string): void {
  connection(root).prepare(`INSERT INTO sdk_session_summaries SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, fingerprint=excluded.fingerprint, body=excluded.body`)
    .run(stamp, body, sessionId, file);
}

// The saved text of a Pi settings file, or undefined.
function sdkSettingsText(root: string, file: string): string | undefined {
  return (connection(root).prepare('SELECT body FROM sdk_settings WHERE path=?').get(file) as { body: string | null } | undefined)?.body ?? undefined;
}

export { localSessionRows, captureSessionFileMetadata, forgetSessionFileMetadata, saveSessionFileMetadata, sidebarSummaries, replaceSidebarSummaries, storageTranscriptSummary, saveStorageTranscriptSummary, transcriptReferenceEntries, saveTranscriptReference, appendTranscriptReference, saveMailboxReceipts, appendMailboxReceipts, removeTranscriptCachesUnder, sdkSessionListRows, saveSdkSessionSummary, sdkSettingsText };
