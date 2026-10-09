const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const request = JSON.parse(process.argv[1]);

const relocate = process.argv[2];

const { createRecoveryStorage, readSession } = require('./recovery-storage.cjs');

const profileRoot = path.join(os.homedir(), request.storage || process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const storage = createRecoveryStorage(profileRoot);

const header = readSession(profileRoot, request.sessionPath);

function registry(action, details) {
  return JSON.parse(execFileSync(process.execPath, ['-e', process.argv[3], JSON.stringify({ action, root: profileRoot, ...details })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }) || 'null');
}

if (request.action === 'inspect') {
  const current = storage.current(header, request.sessionPath);

  process.stdout.write(JSON.stringify({
    cwd: header.cwd,
    managedRoot: storage.root,
    currentRecovery: current ?? null,
    retainedDirectories: storage.retained(header, request.sessionPath).map(record => ({ directory: record.directory, state: record.state, mode: record.mode })),
  }));

  process.exit(0);
}

function assertMissingDirectory() {
  try {
    fs.lstatSync(header.cwd);

    throw new Error('The session directory exists again. Refresh the session list before opening it.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publish(record) {
  const current = readSession(profileRoot, request.sessionPath);

  if (current.id !== header.id || current.cwd !== header.cwd) throw new Error('The conversation changed during recovery. The durable recovery files have been retained; refresh before retrying.');

  try {
    execFileSync(process.execPath, ['-e', relocate, request.sessionPath, record.directory], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (error) {
    if (readSession(profileRoot, request.sessionPath).cwd !== record.directory) throw error;
  }

  storage.published(record, request.sessionPath);

  reportRecovery(record);
}

function reportRecovery(record) {
  const warnings = [];

  if (record.recovered?.unmanagedTemporarySymlinks?.length) warnings.push(`Links to temporary files outside this recovery directory were retained; their external contents were not copied: ${record.recovered.unmanagedTemporarySymlinks.join(', ')}`);

  try { registry('record', { sessionId: header.id, sessionPath: request.sessionPath, cwd: record.directory }); }
  catch (error) { warnings.push(`The recovery directory is published, but the directory registry needs reindexing: ${error.message}`); }

  process.stdout.write(JSON.stringify({ cwd: record.directory, recovery: record, warnings }));
}

if (request.action !== 'empty') throw new Error('Unknown recovery action');

const current = storage.current(header, request.sessionPath);

if (current && fs.existsSync(current.directory)) {
  storage.published(current, request.sessionPath);

  reportRecovery(current);

  process.exit(0);
}

{
  assertMissingDirectory();

  const record = storage.find(header, request.sessionPath, 'empty') || storage.allocate(header, request.sessionPath, 'empty');
  fs.mkdirSync(record.directory, { recursive: true, mode: 0o700 });
  storage.ready(record, {});
  publish(record);
}
