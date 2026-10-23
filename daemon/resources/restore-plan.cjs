const stateRecords = require('./piop-storage/session-records.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');

function absent(file) {
  if (io.exists(file)) throw new Error(`Restoration destination already exists: ${file}`);
}

function readArchive(root, file) {
  const archive = fs.realpathSync(path.join(root, 'archived'));

  if (!file.startsWith(archive + path.sep) || !file.endsWith('.jsonl')) throw new Error('Only archived sessions can be restored');
  const entries = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => line.trim() ? [JSON.parse(line)] : []);
  const header = entries[0];

  if (header?.type !== 'session' || !Check(Type.String({ minLength: 1 }), header.id) || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid archived session header');

  return { path: file, entries: stateRecords.merge(file, entries), header };
}

function referencedPaths(records) {
  const paths = new Map();

  for (const { entries } of records) {
    for (const entry of entries) {
      if (entry.type !== 'custom') continue;
      const data = entry.data;

      if (entry.customType === 'piop-review' && Check(Type.String(), data?.sessionPath)) paths.set(data.sessionId, data.sessionPath);

      if (entry.customType === 'piop-subagent-parent' && Check(Type.String(), data?.parentSessionPath)) paths.set(data.parentSessionId, data.parentSessionPath);
    }
  }

  return paths;
}

function checkSessionDirectory(sessions, relative) {
  let parent = sessions;

  for (const component of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, component);

    if (!io.exists(parent)) return;

    if (!fs.lstatSync(parent).isDirectory()) throw new Error('Invalid restored session directory');
  }
}

function destinationPath(sessions, record, references) {
  const destination = record.header.archiveSessionPath ?? references.get(record.header.id) ?? path.join(sessions, canonicalTranscriptBasename(record.header));

  if (!Check(Type.String(), destination) || !path.isAbsolute(destination) || !destination.endsWith('.jsonl')) throw new Error('Invalid saved session path');
  const relative = path.relative(sessions, destination);

  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Restored sessions must remain in session storage');
  checkSessionDirectory(sessions, relative);

  return path.join(sessions, relative);
}

function planTargets(root, files) {
  const records = files.map(file => readArchive(root, file));
  const sessions = path.join(root, 'sessions');

  const canonicalSessions = io.exists(sessions) ? fs.realpathSync(sessions) : path.join(fs.realpathSync(root), 'sessions');
  const references = referencedPaths(records);
  const destinations = new Set();
  const ids = new Set();

  return records.map(record => {
    const destination = destinationPath(canonicalSessions, record, references);

    if (ids.has(record.header.id) || destinations.has(destination)) throw new Error('Duplicate session in restoration');
    ids.add(record.header.id);
    destinations.add(destination);

    for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots')]) absent(target);

    return { path: record.path, sessionId: record.header.id, cwd: record.header.cwd, destination, entries: record.entries };
  });
}

module.exports = { planTargets };
