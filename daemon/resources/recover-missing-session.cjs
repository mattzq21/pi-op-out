const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const request = JSON.parse(process.argv[1]);

const relocate = process.argv[2];

const { createRecoveryStorage, existingLegacyDirectory, legacyDirectory, readSession } = require('./recovery-storage.cjs');

const profileRoot = path.join(os.homedir(), request.storage || process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const storage = createRecoveryStorage(profileRoot);

const header = readSession(profileRoot, request.sessionPath);

const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function registry(action, details) {
  return JSON.parse(execFileSync(process.execPath, ['-e', process.argv[3], JSON.stringify({ action, root: profileRoot, ...details })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }) || 'null');
}

function savedRepository() {
  try { return registry('get', { sessionId: header.id }); }
  catch (error) {
    console.error(`Saved recovery details are unavailable: ${error.message}`);

    return null;
  }
}

const manualDetails = request.action === 'remote' && request.repository?.trim() && request.branch?.trim();

const saved = manualDetails ? null : savedRepository();

if (request.action === 'inspect') {
  const current = storage.current(header, request.sessionPath);

  process.stdout.write(JSON.stringify({
    canRecoverRemote: Boolean(saved?.remote_url && (saved?.upstream_branch || saved?.branch)),
    cwd: header.cwd,
    managedRoot: storage.root,
    legacyRecovery: legacyDirectory(header.cwd) ? (existingLegacyDirectory(header.cwd) ? 'available' : 'missing') : null,
    stagedDirectory: storage.find(header, request.sessionPath, 'legacy-copy')?.directory ?? null,
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

function allocationBranch() {
  const container = path.dirname(header.cwd);

  if (path.dirname(container) !== path.join(profileRoot, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(container))) return;

  try { return require('./session-database.cjs').worktreeMetadata(container)?.branch; } catch { }
}

function remoteBranch() {
  return request.branch?.trim() || saved?.upstream_branch || saved?.branch || allocationBranch();
}

function remoteRepository() {
  let repository = request.repository?.trim() || saved?.remote_url;

  if (!repository) repository = header.checkpointRepositoryRoot || header.worktreeRestore?.repositoryRoot;

  if (!repository) {
    const entries = fs.readFileSync(request.sessionPath, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);

    repository = entries.findLast(entry => entry.data?.repositoryRoot)?.data.repositoryRoot;
  }

  return repository;
}

function remoteDetails() {
  const branch = remoteBranch();

  const repository = remoteRepository();

  const missingFields = [];

  if (!branch) missingFields.push('branch');

  if (!repository || (path.isAbsolute(repository) && !fs.existsSync(repository))) missingFields.push('repository');

  return { repository, branch, missingFields };
}

function gitState(directory) {
  try {
    return {
      headCommit: git(['-C', directory, 'rev-parse', '--verify', 'HEAD']),
      branch: git(['-C', directory, 'branch', '--show-current']),
    };
  } catch { return { headCommit: null, branch: null }; }
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
  catch (error) { warnings.push(`The recovery directory is published, but the repository registry needs reindexing: ${error.message}`); }

  process.stdout.write(JSON.stringify({ cwd: record.directory, recovery: record, warnings }));
}

if (!['empty', 'remote', 'migrate'].includes(request.action)) throw new Error('Unknown recovery action');

const current = storage.current(header, request.sessionPath);

if (current && fs.existsSync(current.directory)) {
  storage.published(current, request.sessionPath);

  reportRecovery(current);

  process.exit(0);
}

if (request.action === 'migrate') {
  const record = storage.migrate(header, request.sessionPath);

  storage.ready(record, { ...record.recovered, ...gitState(record.directory) });

  publish(record);
} else {
  assertMissingDirectory();

  if (request.action === 'empty') {
    const record = storage.find(header, request.sessionPath, 'empty') || storage.allocate(header, request.sessionPath, 'empty');

    fs.mkdirSync(record.directory, { recursive: true, mode: 0o700 });

    storage.ready(record, gitState(record.directory));

    publish(record);
  } else {
    const details = remoteDetails();

    if (details.missingFields.length) {
      process.stdout.write(JSON.stringify({ missingFields: details.missingFields }));

      process.exit(0);
    }

    let { repository } = details;

    const { branch } = details;

    git(['check-ref-format', '--branch', branch]);

    if (fs.existsSync(repository)) repository = git(['-C', repository, 'remote', 'get-url', 'origin']);

    let record = storage.find(header, request.sessionPath, 'remote-branch');

    if (record?.recovered?.repository !== repository || record?.recovered?.branch !== branch) record = null;

    if (!record) {
      record = storage.allocate(header, request.sessionPath, 'remote-branch');

      git(['clone', '--no-local', '--single-branch', '--branch', branch, '--', repository, record.directory]);
    }

    const headCommit = git(['-C', record.directory, 'rev-parse', '--verify', 'HEAD']);

    const actualBranch = git(['-C', record.directory, 'branch', '--show-current']);

    if (actualBranch !== branch) throw new Error('The remote recovery did not check out the requested branch');

    storage.ready(record, { repository, branch: actualBranch, headCommit, semantics: 'latest-remote-branch' });

    publish(record);
  }
}
