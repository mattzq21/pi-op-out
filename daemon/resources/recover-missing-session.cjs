const fs = require('node:fs');
const { createRecoveryStorage, readSession } = require('./recovery-storage.cjs');
const { relocateSession } = require('./relocate-session.cjs');
const { recordDirectory } = require('./session-registry.cjs');

function assertMissingDirectory(header) {
  try {
    fs.lstatSync(header.cwd);

    throw new Error('The session directory exists again. Refresh the session list before opening it.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Gives the session at request.sessionPath a new empty directory in the profile at request.profile when its directory is missing. */
function recoverMissingSession(request) {
  if (request.action !== 'empty') throw new Error('Unknown recovery action');
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string') throw new Error('Invalid recovery request');
  const profileRoot = request.profile;
  const storage = createRecoveryStorage(profileRoot);
  const header = readSession(profileRoot, request.sessionPath);

  const report = record => {
    const warnings = [];

    if (record.recovered?.unmanagedTemporarySymlinks?.length) warnings.push(`Links to temporary files outside this recovery directory were retained; their external contents were not copied: ${record.recovered.unmanagedTemporarySymlinks.join(', ')}`);

    try { recordDirectory({ root: profileRoot, sessionId: header.id, sessionPath: request.sessionPath, cwd: record.directory }); }
    catch (error) { warnings.push(`The recovery directory is published, but the directory registry needs reindexing: ${error.message}`); }

    return { cwd: record.directory, recovery: record, warnings };
  };

  const current = storage.current(header, request.sessionPath);

  if (current && fs.existsSync(current.directory)) {
    storage.published(current, request.sessionPath);

    return report(current);
  }

  assertMissingDirectory(header);
  const record = storage.find(header, request.sessionPath, 'empty') || storage.allocate(header, request.sessionPath, 'empty');
  fs.mkdirSync(record.directory, { recursive: true, mode: 0o700 });
  storage.ready(record, {});
  const latest = readSession(profileRoot, request.sessionPath);

  if (latest.id !== header.id || latest.cwd !== header.cwd) throw new Error('The conversation changed during recovery. The durable recovery files have been retained; refresh before retrying.');

  try { relocateSession(profileRoot, request.sessionPath, record.directory); }
  catch (error) {
    if (readSession(profileRoot, request.sessionPath).cwd !== record.directory) throw error;
  }

  storage.published(record, request.sessionPath);

  return report(record);
}

module.exports = { recoverMissingSession };
