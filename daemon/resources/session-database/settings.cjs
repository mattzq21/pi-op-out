const { connection, rows } = require('./core.cjs');

// Settings, inventories, restart records, project repositories and session groups in the storage database.

function blob(value) { return value === null || value === undefined ? undefined : Buffer.from(value); }

function applicationSetting(root, name) {
  return blob(connection(root).prepare('SELECT body FROM application_settings WHERE name=?').get(name)?.body);
}

function saveApplicationSetting(root, name, body) {
  connection(root).prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name, body);
}

// Fails when the setting exists.
function createApplicationSetting(root, name, body) {
  connection(root).prepare('INSERT INTO application_settings (name, body) VALUES (?, ?)').run(name, body);
}

function removeApplicationSetting(root, name) {
  connection(root).prepare('DELETE FROM application_settings WHERE name=?').run(name);
}

function projectAgentDefinition(root, directory) {
  return blob(connection(root).prepare('SELECT body FROM project_agent_definitions WHERE directory=?').get(directory)?.body);
}

function projectAgentDefinitions(root) {
  return rows(root, 'SELECT directory, body FROM project_agent_definitions').map(row => ({ directory: String(row.directory), body: Buffer.from(row.body) }));
}

function saveProjectAgentDefinition(root, directory, body) {
  connection(root).prepare('INSERT INTO project_agent_definitions (directory, body) VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET body=excluded.body').run(directory, body);
}

function removeProjectAgentDefinition(root, directory) {
  connection(root).prepare('DELETE FROM project_agent_definitions WHERE directory=?').run(directory);
}

// The saved body of a Pi setting, or null when it has none.
function sdkSettingBody(root, path) {
  return connection(root).prepare('SELECT body FROM sdk_settings WHERE path=?').get(path)?.body ?? null;
}

function saveSdkSettingBody(root, path, body) {
  connection(root).prepare('INSERT INTO sdk_settings VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET body=excluded.body').run(path, body);
}

// Keeps the contents saved first for digest.
function saveAgentPromptSnapshot(root, digest, contents) {
  connection(root).prepare('INSERT INTO agent_prompt_snapshots VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET contents=COALESCE(agent_prompt_snapshots.contents, excluded.contents)').run(digest, contents);
}

function agentPromptSnapshot(root, digest) {
  return connection(root).prepare('SELECT contents FROM agent_prompt_snapshots WHERE digest=?').get(digest)?.contents ?? undefined;
}

function toolInventoryJson(root) {
  return connection(root).prepare('SELECT entries_json FROM tool_inventory WHERE id=1').get()?.entries_json;
}

function saveToolInventoryJson(root, entries) {
  connection(root).prepare('INSERT INTO tool_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
}

function commandInventoryJson(root) {
  return connection(root).prepare('SELECT entries_json FROM command_inventory WHERE id=1').get()?.entries_json;
}

function saveCommandInventoryJson(root, entries) {
  connection(root).prepare('INSERT INTO command_inventory VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET entries_json=excluded.entries_json').run(entries);
}

function skillInventoryJson(root, skillRoot) {
  return connection(root).prepare('SELECT entries_json FROM skill_inventory WHERE root=?').get(skillRoot)?.entries_json;
}

function saveSkillInventoryJson(root, skillRoot, entries) {
  connection(root).prepare('INSERT INTO skill_inventory VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET entries_json=excluded.entries_json').run(skillRoot, entries);
}

function restartRecordJson(root, name) {
  return connection(root).prepare('SELECT record_json FROM restart_records WHERE name=?').get(name)?.record_json;
}

function saveRestartRecordJson(root, name, record) {
  connection(root).prepare('INSERT INTO restart_records VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET record_json=excluded.record_json').run(name, record);
}

function removeRestartRecord(root, name) {
  connection(root).prepare('DELETE FROM restart_records WHERE name=?').run(name);
}

function saveRestartBackup(root, id, digest) {
  connection(root).prepare('INSERT INTO restart_backups VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest').run(id, digest);
}

function restartBackup(root, id) {
  const row = connection(root).prepare('SELECT digest FROM restart_backups WHERE id=?').get(id);
  return row ? { digest: row.digest ?? null } : undefined;
}

function removeRestartBackup(root, id) {
  connection(root).prepare('DELETE FROM restart_backups WHERE id=?').run(id);
}

function restartBackupIds(root) {
  return rows(root, 'SELECT id FROM restart_backups ORDER BY id').map(row => String(row.id));
}

// The saved repository of the project folder cwd: undefined when not saved, null when it has none.
function projectRepositoryJson(root, cwd) {
  const row = connection(root).prepare('SELECT repository FROM project_repositories WHERE cwd=?').get(cwd);
  return row ? row.repository ?? null : undefined;
}

function saveProjectRepositoryJson(root, cwd, repository) {
  connection(root).prepare('INSERT INTO project_repositories(cwd, repository) VALUES (?, ?) ON CONFLICT(cwd) DO UPDATE SET repository=excluded.repository').run(cwd, repository);
}

function removeProjectRepository(root, cwd) {
  connection(root).prepare('DELETE FROM project_repositories WHERE cwd=?').run(cwd);
}

// The saved session groups, or undefined before they were first saved. Run it in a transaction.
function sessionGroupRows(root) {
  const db = connection(root);
  if (!db.prepare('SELECT initialized FROM session_group_state WHERE id=1').get().initialized) return undefined;
  return {
    groups: db.prepare('SELECT group_id, name, cwd, host_id, host_name FROM session_groups ORDER BY position, group_id').all()
      .map(row => ({ id: row.group_id, name: row.name, cwd: row.cwd ?? null, hostId: row.host_id ?? null, hostName: row.host_name ?? null })),
    assignments: db.prepare('SELECT session_key, group_id FROM session_group_assignments').all().map(row => [row.session_key, row.group_id ?? null]),
    removedProjects: db.prepare('SELECT project_id FROM session_group_removed_projects').all().map(row => row.project_id),
    parents: db.prepare('SELECT group_id, parent_id FROM session_group_parents').all().map(row => [row.group_id, row.parent_id]),
    orders: db.prepare('SELECT scope, owner, token FROM session_group_orders ORDER BY scope, owner, position').all()
      .map(row => ({ scope: row.scope, owner: row.owner, token: row.token })),
  };
}

// Replaces all saved session groups. Run it in a transaction.
function replaceSessionGroupRows(root, state) {
  const db = connection(root);
  db.exec('DELETE FROM session_groups; DELETE FROM session_group_parents; DELETE FROM session_group_assignments; DELETE FROM session_group_removed_projects; DELETE FROM session_group_orders;');
  const insertGroup = db.prepare('INSERT INTO session_groups (group_id, position, name, cwd, host_id, host_name) VALUES (?, ?, ?, ?, ?, ?)');
  state.groups.forEach((group, position) => insertGroup.run(group.id, position, group.name, group.cwd, group.hostId, group.hostName));
  const assign = db.prepare('INSERT INTO session_group_assignments VALUES (?, ?)');
  for (const [key, group] of state.assignments) assign.run(key, group);
  const parent = db.prepare('INSERT INTO session_group_parents VALUES (?, ?)');
  for (const [id, value] of state.parents) parent.run(id, value);
  const removed = db.prepare('INSERT INTO session_group_removed_projects VALUES (?)');
  for (const project of state.removedProjects) removed.run(project);
  const order = db.prepare('INSERT INTO session_group_orders VALUES (?, ?, ?, ?)');
  for (const { scope, owner, position, token } of state.orders) order.run(scope, owner, position, token);
  db.exec('UPDATE session_group_state SET initialized=1 WHERE id=1');
}

module.exports = { applicationSetting, saveApplicationSetting, createApplicationSetting, removeApplicationSetting, projectAgentDefinition,
  projectAgentDefinitions, saveProjectAgentDefinition, removeProjectAgentDefinition, sdkSettingBody, saveSdkSettingBody,
  saveAgentPromptSnapshot, agentPromptSnapshot, toolInventoryJson, saveToolInventoryJson, commandInventoryJson, saveCommandInventoryJson,
  skillInventoryJson, saveSkillInventoryJson, restartRecordJson, saveRestartRecordJson, removeRestartRecord, saveRestartBackup, restartBackup,
  removeRestartBackup, restartBackupIds, projectRepositoryJson, saveProjectRepositoryJson, removeProjectRepository, sessionGroupRows,
  replaceSessionGroupRows };
