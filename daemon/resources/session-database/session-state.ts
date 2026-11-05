import { connection } from './core.ts';


// The state records of each chat: the custom entries that Pi extensions add, the current one of each key, and the
// selected branch.

function sessionStateRecord(root: string, sessionId: string, entryId: string): { after_id: string | null; entry_json: string } | undefined {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? AND entry_id=?').get(sessionId, entryId) as { after_id: string | null; entry_json: string } | undefined;
}

// Adds a state record; does nothing when the chat has a record with its ID.
function seedSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, entry_id) DO NOTHING')
    .run(sessionId, entryId, after, entryJson);
}

function appendSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entryId, after, entryJson);
}

function sessionStateRecords(root: string, sessionId: string): Array<{ after_id: string | null; entry_json: string }> {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId) as Array<{ after_id: string | null; entry_json: string }>;
}

function sessionStateSequence(root: string, sessionId: string): number {
  return (connection(root).prepare('SELECT coalesce(max(sequence), 0) AS revision FROM session_extension_records WHERE session_id=?').get(sessionId) as { revision: number }).revision;
}

function currentSessionStates(root: string, sessionId: string): Array<{ state_key: string; entry_json: string }> {
  return connection(root).prepare('SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId) as Array<{ state_key: string; entry_json: string }>;
}

function saveCurrentSessionState(root: string, sessionId: string, key: string, entryJson: string): void {
  connection(root).prepare(`INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json`).run(sessionId, key, entryJson);
}

function branchSelection(root: string, sessionId: string): { tip_id: string | null; leaf_id: string | null } | undefined {
  return connection(root).prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId) as { tip_id: string | null; leaf_id: string | null } | undefined;
}

function saveBranchSelection(root: string, sessionId: string, tipId: string | null, leafId: string | null): void {
  connection(root).prepare(`INSERT INTO session_branch_selection (session_id, tip_id, leaf_id) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET tip_id=excluded.tip_id, leaf_id=excluded.leaf_id`).run(sessionId, tipId, leafId);
}

// The current state record key of sessionId, as JSON; undefined when the chat has none.
function currentSessionState(root: string, sessionId: string, key: string): string | undefined {
  return (connection(root).prepare('SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key=?').get(sessionId, key) as { entry_json: string } | undefined)?.entry_json;
}

export { sessionStateRecord, seedSessionStateRecord, appendSessionStateRecord, sessionStateRecords, sessionStateSequence, currentSessionStates, currentSessionState, saveCurrentSessionState, branchSelection, saveBranchSelection };
