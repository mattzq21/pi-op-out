const { acquireReferencePublicationLock } = require('./storage-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { exists, restoreGroup, restoredResult, lockStorage } = require('./restore-transaction.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const transactions = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');

const configuredRoot = process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const root = fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : path.resolve(configuredRoot);

function absent(file) {
  if (exists(file)) throw new Error(`Restoration destination already exists: ${file}`);
}

function readArchive(file) {
  const archive = fs.realpathSync(path.join(root, 'archived'));

  if (!file.startsWith(archive + path.sep) || !file.endsWith('.jsonl')) throw new Error('Only archived conversations can be restored');
  const entries = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => line.trim() ? [JSON.parse(line)] : []);
  const header = entries[0];

  if (header?.type !== 'session' || !Check(Type.String({ minLength: 1 }), header.id) || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid archived session header');

  return { file, entries, header };
}

function referencedPaths(records) {
  const paths = new Map();

  for (const { entries } of records) {
    for (const entry of entries) {
      if (entry.type !== 'custom') continue;
      const data = entry.data;

      if (['piop-review', 'piop-subagent-run'].includes(entry.customType) && Check(Type.String(), data?.sessionPath)) paths.set(data.sessionId, data.sessionPath);

      if (entry.customType === 'piop-subagent-parent' && Check(Type.String(), data?.parentSessionPath)) paths.set(data.parentSessionId, data.parentSessionPath);
    }
  }

  return paths;
}

function prepareSessionDirectory(sessions, relative) {
  let parent = sessions;

  for (const component of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, component);

    if (!exists(parent)) fs.mkdirSync(parent, { mode: 0o700 });

    if (!fs.lstatSync(parent).isDirectory()) throw new Error('Invalid restored conversation directory');
  }
}

function destinationPath(sessions, record, references) {
  const destination = record.header.archiveSessionPath ?? references.get(record.header.id) ?? path.join(sessions, canonicalTranscriptBasename(record.header));

  if (!Check(Type.String(), destination) || !path.isAbsolute(destination) || !destination.endsWith('.jsonl')) throw new Error('Invalid saved conversation path');
  const relative = path.relative(sessions, destination);

  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Restored conversations must remain in session storage');
  prepareSessionDirectory(sessions, relative);

  return path.join(sessions, relative);
}

function restoreArchives(files) {
  const records = files.map(readArchive);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const canonicalSessions = fs.realpathSync(sessions);
  const references = referencedPaths(records);
  const destinations = new Set();
  const ids = new Set();

  for (const record of records) {
    const destination = destinationPath(canonicalSessions, record, references);

    if (ids.has(record.header.id) || destinations.has(destination)) throw new Error('Duplicate conversation in restoration');
    ids.add(record.header.id); destinations.add(destination);

    for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots'), `${destination}.loop-detection.json`]) absent(target);

    record.destination = destination;
    record.result = { path: record.header.cwd, sessionPath: destination };
  }

  return restoreGroup(root, records);
}

function main() {
  transactions.recover(root);
  recoverStorage(root);

  if (process.argv[1] === '--result') return restoredResult(root, process.argv[2]);

  if (process.argv[1] === '--recover') return;

  const files = process.argv[1] === '--group' ? JSON.parse(process.argv[2]) : [process.argv[1] === '--session' ? process.argv[2] : process.argv[1]];

  if (!Check(Type.Array(Type.String(), { minItems: 1 }), files)) throw new Error('No archived conversations selected');

  const selected = [...new Set(files.map(file => fs.realpathSync(file)))];

  return restoreArchives(selected);
}

try {
  if (lockStorage(root)) {
    const release = acquireReferencePublicationLock(root);

    try { process.stdout.write(JSON.stringify(main() ?? null)); } finally { release(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

