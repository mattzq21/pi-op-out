const { connection, transaction } = require('./core.cjs');

// Goals of chats and the records of goal folders: their preparations, owners, dependencies, texts, recoveries and
// reclamations. A goal folder record is keyed by the folder path and the folder identity (device:inode).

function get(root, sql, ...parameters) { return connection(root).prepare(sql).get(...parameters); }

function all(root, sql, ...parameters) { return connection(root).prepare(sql).all(...parameters); }

function run(root, sql, ...parameters) { return connection(root).prepare(sql).run(...parameters); }

// Chat goals.

function goalSessionId(root, file, sessionId) {
  const row = sessionId
    ? get(root, 'SELECT session_id FROM sessions WHERE session_id=? AND session_path=?', sessionId, file)
    : get(root, 'SELECT session_id FROM sessions WHERE session_path=?', file);

  return row?.session_id;
}

function sessionGoal(root, sessionId) {
  const row = get(root, 'SELECT goal_id AS id, session_id AS sessionId, objective, status FROM session_goals WHERE session_id=?', sessionId);

  return row ? { ...row } : null;
}

function goalInputHold(root, sessionId) {
  return get(root, "SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-input-hold'", sessionId)?.entry_json;
}

function removeSessionGoal(root, sessionId) { run(root, 'DELETE FROM session_goals WHERE session_id=?', sessionId); }

function saveSessionGoal(root, sessionId, goal) {
  transaction(root, 'IMMEDIATE', () => {
    run(root, 'INSERT INTO session_goal_ids VALUES (?, ?) ON CONFLICT(goal_id) DO NOTHING', goal.id, sessionId);
    if (get(root, 'SELECT session_id FROM session_goal_ids WHERE goal_id=?', goal.id).session_id !== sessionId) throw new Error('Goal identity belongs to another conversation');
    run(root, `INSERT INTO session_goals VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status`,
      sessionId, goal.id, goal.objective, goal.status);
  });
}

// Goal preparations.

function goalPreparation(root, directory, identity) {
  return get(root, 'SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?', directory, identity);
}

function goalPreparationReplaced(root, directory, identity) {
  return Boolean(get(root, 'SELECT 1 FROM goal_preparations WHERE directory=? AND identity<>? AND record_json IS NOT NULL', directory, identity));
}

function goalPreparationsOf(root, directory) {
  return all(root, 'SELECT identity, record_json FROM goal_preparations WHERE directory=? AND record_json IS NOT NULL', directory);
}

function saveGoalPreparation(root, directory, identity, text) {
  run(root, 'INSERT INTO goal_preparations VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json', directory, identity, text);
}

function goalPreparationRetained(root, directory, identity) {
  return Boolean(get(root, 'SELECT 1 FROM goal_preparations WHERE directory=? AND identity=? AND record_json IS NOT NULL', directory, identity));
}

function removeGoalPreparation(root, directory, identity) { run(root, 'DELETE FROM goal_preparations WHERE directory=? AND identity=?', directory, identity); }

// Goal folder owners.

function goalOwnership(root, directory, identity) {
  return get(root, 'SELECT record_json FROM goal_ownership WHERE directory=? AND identity=?', directory, identity);
}

function goalOwnershipReplaced(root, directory, identity) {
  return Boolean(get(root, 'SELECT 1 FROM goal_ownership WHERE directory=? AND identity<>? AND record_json IS NOT NULL', directory, identity));
}

function goalOwnershipsOf(root, directory) {
  return all(root, 'SELECT identity, record_json FROM goal_ownership WHERE directory=? AND record_json IS NOT NULL', directory);
}

function saveGoalOwnership(root, directory, identity, text) {
  run(root, 'INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json', directory, identity, text);
}

function goalOwnershipRetained(root, directory, identity) {
  return Boolean(get(root, 'SELECT 1 FROM goal_ownership WHERE directory=? AND identity=? AND record_json IS NOT NULL', directory, identity));
}

function removeGoalOwnership(root, directory, identity) { run(root, 'DELETE FROM goal_ownership WHERE directory=? AND identity=?', directory, identity); }

// Reserves the path directory for a new goal folder. Returns 1 when reserved, 0 when another folder has it.
function reserveGoalDirectory(root, directory) {
  return Number(run(root, 'INSERT INTO goal_ownership VALUES (?, ?, NULL) ON CONFLICT DO NOTHING', directory, '').changes);
}

function publishGoalDirectory(root, directory, identity) {
  transaction(root, 'IMMEDIATE', () => {
    run(root, 'INSERT INTO goal_ownership VALUES (?, ?, NULL)', directory, identity);
    run(root, "INSERT INTO goal_text_files VALUES (?, ?, '[]')", directory, identity);
    run(root, "INSERT INTO goal_text_contents VALUES (?, ?, '[]')", directory, identity);
    run(root, "DELETE FROM goal_ownership WHERE directory=? AND identity=''", directory);
  });
}

function goalOwnedDirectories(root, sessionId) {
  const rows = sessionId === undefined
    ? all(root, 'SELECT DISTINCT directory FROM goal_ownership')
    : all(root, `SELECT DISTINCT directory FROM goal_ownership
        WHERE EXISTS (SELECT 1 FROM json_each(record_json, '$.owners') AS owner
          WHERE json_extract(owner.value, '$.sessionId')=?)`, sessionId);

  return rows.map(row => row.directory);
}

// True when the goal folder is reserved or allocated but has no owners yet.
function goalDirectoryUnpublished(root, directory, identity) {
  return Boolean(get(root, "SELECT 1 FROM goal_ownership WHERE directory=? AND identity IN (?, '') AND record_json IS NULL", directory, identity));
}

// Goal folder dependencies and texts.

function goalDependency(root, directory, identity) {
  return get(root, 'SELECT record_json FROM goal_asset_dependencies WHERE directory=? AND identity=?', directory, identity);
}

function saveGoalDependency(root, directory, identity, text) {
  run(root, 'INSERT INTO goal_asset_dependencies VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json', directory, identity, text);
}

function goalDependencyRetained(root, directory, identity) {
  return Boolean(get(root, 'SELECT 1 FROM goal_asset_dependencies WHERE directory=? AND identity=? AND record_json IS NOT NULL', directory, identity));
}

function removeGoalDependency(root, directory, identity) { run(root, 'DELETE FROM goal_asset_dependencies WHERE directory=? AND identity=?', directory, identity); }

function goalTextFileNames(root, directory, identity) {
  return get(root, 'SELECT names_json FROM goal_text_files WHERE directory=? AND identity=?', directory, identity)?.names_json;
}

function goalTextContents(root, directory, identity) {
  return get(root, 'SELECT contents_json FROM goal_text_contents WHERE directory=? AND identity=?', directory, identity)?.contents_json;
}

function saveGoalTexts(root, directory, identity, names, contents) {
  transaction(root, 'IMMEDIATE', () => {
    run(root, 'INSERT INTO goal_text_files VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET names_json=excluded.names_json', directory, identity, JSON.stringify(names));
    run(root, 'INSERT INTO goal_text_contents VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET contents_json=excluded.contents_json', directory, identity, JSON.stringify(contents));
  });
}

// Removes the texts of the goal folder and the record of the identities it had before.
function removeGoalTexts(root, directory, identity) {
  transaction(root, 'IMMEDIATE', () => {
    run(root, 'DELETE FROM goal_text_files WHERE directory=? AND identity=?', directory, identity);
    run(root, 'DELETE FROM goal_text_contents WHERE directory=? AND identity=?', directory, identity);
    run(root, 'DELETE FROM goal_directory_history WHERE directory=? AND current_identity=?', directory, identity);
  });
}

// True when the goal folder with identity previous was made again with identity current.
function goalDirectoryRemade(root, directory, previous, current) {
  return Boolean(get(root, 'SELECT 1 FROM goal_directory_history WHERE directory=? AND previous_identity=? AND current_identity=?', directory, previous, current));
}

// The saved dependencies and texts of a goal folder that has owners.
function goalSavedReferences(root, directory, identity) {
  return all(root, `SELECT d.record_json, t.contents_json FROM goal_asset_dependencies d
    JOIN goal_text_contents t USING(directory, identity) JOIN goal_ownership o USING(directory, identity)
    WHERE d.directory=? AND d.identity=? AND o.record_json IS NOT NULL`, directory, identity);
}

// Goal folder recoveries.

function goalDirectoryRecovery(root, directory) {
  return get(root, 'SELECT record_json FROM goal_directory_recoveries WHERE directory=?', directory)?.record_json;
}

function saveGoalDirectoryRecovery(root, directory, record) {
  run(root, 'INSERT INTO goal_directory_recoveries VALUES (?, ?)', directory, JSON.stringify(record));
}

// Moves the records of the goal folder from its old identity to the new folder, and ends its recovery.
function moveGoalDirectoryRecords(root, directory, record) {
  transaction(root, 'IMMEDIATE', () => {
    for (const table of ['goal_preparations', 'goal_ownership', 'goal_asset_dependencies', 'goal_text_files', 'goal_text_contents']) {
      run(root, `UPDATE ${table} SET identity=? WHERE directory=? AND identity=?`, record.current, directory, record.previous);
    }

    run(root, 'UPDATE goal_directory_history SET current_identity=? WHERE directory=? AND current_identity=?', record.current, directory, record.previous);
    run(root, 'INSERT INTO goal_directory_history VALUES (?, ?, ?) ON CONFLICT(directory, previous_identity) DO UPDATE SET current_identity=excluded.current_identity',
      directory, record.previous, record.current);
    run(root, 'DELETE FROM goal_ownership WHERE directory=? AND identity=?', record.staging, record.current);

    for (const table of ['goal_text_files', 'goal_text_contents']) run(root, `DELETE FROM ${table} WHERE directory=? AND identity=?`, record.staging, record.current);
    run(root, 'DELETE FROM goal_directory_recoveries WHERE directory=?', directory);
  });
}

// The recoveries that fill the staging folder with this identity.
function goalRecoveriesStagedIn(root, staging, identity) {
  return all(root, "SELECT directory, record_json FROM goal_directory_recoveries WHERE json_extract(record_json, '$.staging')=? AND json_extract(record_json, '$.current')=?", staging, identity);
}

function removeGoalDirectoryRecovery(root, directory, text) {
  run(root, 'DELETE FROM goal_directory_recoveries WHERE directory=? AND record_json=?', directory, text);
}

// Goal folder deletions.

function goalReclamation(root, key) {
  return get(root, 'SELECT record_json FROM goal_asset_reclamations WHERE record_id=?', key)?.record_json;
}

function saveGoalReclamation(root, key, record) { run(root, 'INSERT INTO goal_asset_reclamations VALUES (?, ?)', key, JSON.stringify(record)); }

function removeGoalReclamation(root, key) { run(root, 'DELETE FROM goal_asset_reclamations WHERE record_id=?', key); }

// Chats, as the goal folder cleanup sees them.

function goalCleanupSessions(root) { return all(root, 'SELECT session_id, session_path FROM sessions'); }

function goalCleanupSessionExists(root, sessionId) { return Boolean(get(root, 'SELECT 1 FROM sessions WHERE session_id=?', sessionId)); }

module.exports = { goalSessionId, sessionGoal, goalInputHold, removeSessionGoal, saveSessionGoal, goalPreparation, goalPreparationReplaced,
  goalPreparationsOf, saveGoalPreparation, goalPreparationRetained, removeGoalPreparation, goalOwnership, goalOwnershipReplaced, goalOwnershipsOf,
  saveGoalOwnership, goalOwnershipRetained, removeGoalOwnership, reserveGoalDirectory, publishGoalDirectory, goalOwnedDirectories,
  goalDirectoryUnpublished, goalDependency, saveGoalDependency, goalDependencyRetained, removeGoalDependency, goalTextFileNames, goalTextContents,
  saveGoalTexts, removeGoalTexts, goalDirectoryRemade, goalSavedReferences, goalDirectoryRecovery, saveGoalDirectoryRecovery,
  moveGoalDirectoryRecords, goalRecoveriesStagedIn, removeGoalDirectoryRecovery, goalReclamation, saveGoalReclamation, removeGoalReclamation,
  goalCleanupSessions, goalCleanupSessionExists };
