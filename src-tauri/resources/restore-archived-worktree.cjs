const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { exists, recover, restoreGroup, restoredResult } = require('./restore-transaction.cjs');

const checkpointSchema = Type.Object({ path: Type.String(), repositoryRoot: Type.String(), ref: Type.String({ pattern: '^refs/pi-session-snapshots/' }), commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }) });

const root = process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

function absent(file) {
  if (exists(file)) throw new Error(`Restoration destination already exists: ${file}`);
}

function lastResponse(entries) {
  const byId = new Map(entries.flatMap(entry => entry.id ? [[entry.id, entry]] : []));
  const visited = new Set();
  let cursor = entries.at(-1);

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);

    if (cursor.type === 'message' && cursor.message?.role === 'assistant') return cursor;
    cursor = byId.get(cursor.parentId);
  }
}

function verifySnapshot(entries, saved) {
  const response = lastResponse(entries);

  const snapshot = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'pi-project-files-watch-snapshot'
    && (saved.kind === 'git' ? entry.data?.ref === saved.ref : response && entry.data?.responseEntryIds?.includes(response.id)));

  if (!snapshot || snapshot.data.unavailable || snapshot.data.ref !== saved.ref || snapshot.data.commit !== saved.commit) throw new Error('The recovery checkpoint cannot be verified');
}

function verifyLocation(header, saved) {
  if (!Check(checkpointSchema, saved) || !path.isAbsolute(saved.path) || !path.isAbsolute(saved.repositoryRoot)) throw new Error('No saved worktree checkpoint is available');
  const owner = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

  if (!saved.ref.startsWith(`refs/pi-session-snapshots/chats/${owner}/`)) throw new Error('The restoration checkpoint is not owned by this archive');
  verifyConversationLocation(header, saved);
}

function verifyConversationLocation(header, saved) {
  const conversationPath = saved.conversationPath ?? header.cwd;

  if (!Check(Type.String(), conversationPath) || !path.isAbsolute(conversationPath)) throw new Error('Invalid archived conversation location');
  const relative = path.relative(saved.path, conversationPath);

  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid archived worktree location');
}

function restoredBranch(saved, git) {
  if (saved.branch !== undefined) {
    if (!Check(Type.String({ minLength: 1, pattern: '^[^-]' }), saved.branch)) throw new Error('Invalid archived branch name');
    git(['check-ref-format', `refs/heads/${saved.branch}`]);

    try { git(['show-ref', '--verify', '--quiet', `refs/heads/${saved.branch}`]); }
    catch (error) { if (error.status === 1) return saved.branch; throw error; }
  }

  return `piop-restored-${randomUUID()}`;
}

function existingWorktree(saved, git) {
  if (!exists(saved.path)) return undefined;

  if (!fs.lstatSync(saved.path).isDirectory()) throw new Error('The archived worktree path is no longer a directory');
  const current = args => execFileSync('git', ['-C', saved.path, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3] }).trim();
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));

  if (fs.realpathSync(current(['rev-parse', '--show-toplevel'])) !== fs.realpathSync(saved.path)
    || fs.realpathSync(current(['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common) throw new Error('The archived worktree path belongs to a different repository');
  let branch = null;

  try { branch = current(['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch (error) { if (error.status !== 1) throw error; }

  return { repositoryRoot: common, path: saved.path, branch, reused: true };
}

function worktreePlan(entries, header) {
  const saved = header.worktreeRestore;
  verifyLocation(header, saved);
  const git = args => execFileSync('git', ['-C', saved.repositoryRoot, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3] }).trim();
  const existing = existingWorktree(saved, git);

  if (existing) return existing;

  if (git(['rev-parse', '--verify', saved.ref]) !== saved.commit) throw new Error('The recovery checkpoint is missing or has changed');
  verifySnapshot(entries, saved);
  absent(saved.path);

  return {
    repositoryRoot: saved.repositoryRoot, path: saved.path, commit: saved.commit, branch: restoredBranch(saved, git),
    staging: path.join(path.dirname(saved.path), `.piop-restore-${randomUUID()}`),
    reservation: `refs/piop-restore-transactions/${randomUUID()}`,
  };
}

function directoryPlan(saved) {
  if (!path.isAbsolute(saved.path ?? '')) throw new Error('Invalid archived directory');

  if (exists(saved.path)) {
    if (!fs.lstatSync(saved.path).isDirectory()) throw new Error('The archived directory path is no longer a directory');

    return { destination: saved.path, reused: true };
  }

  const storage = fs.realpathSync(path.join(root, 'archived-tmp'));
  const stored = fs.realpathSync(saved.storedPath);

  if (path.dirname(stored) !== storage || !fs.lstatSync(stored).isDirectory()) throw new Error('Invalid archived directory');
  absent(saved.path);
  fs.mkdirSync(path.dirname(saved.path), { recursive: true });

  return { source: stored, destination: saved.path, persistent: true, staging: path.join(path.dirname(saved.path), `.piop-restore-${randomUUID()}`) };
}

function readArchive(file) {
  const archive = fs.realpathSync(path.join(root, 'archived'));

  if (!file.startsWith(archive + path.sep) || !file.endsWith('.jsonl')) throw new Error('Only archived conversations can restore worktrees');
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
  const destination = record.header.archiveSessionPath ?? references.get(record.header.id) ?? path.join(sessions, path.basename(record.file));

  if (!Check(Type.String(), destination) || !path.isAbsolute(destination) || !destination.endsWith('.jsonl')) throw new Error('Invalid saved conversation path');
  const relative = path.relative(sessions, destination);

  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Restored conversations must remain in session storage');
  prepareSessionDirectory(sessions, relative);

  return path.join(sessions, relative);
}

function sharedPlan(locations, header, entries) {
  const saved = header.worktreeRestore;

  verifyConversationLocation(header, saved);
  const kind = saved.kind === 'directory' ? 'directory' : 'git';
  const plan = kind === 'directory' ? directoryPlan(saved) : worktreePlan(entries, header);
  const location = kind === 'directory' ? plan.destination : plan.path;
  const signature = JSON.stringify(kind === 'directory' ? [kind] : [kind, fs.realpathSync(plan.repositoryRoot)]);
  const previous = locations.get(location);

  if (previous) {
    if (previous.signature !== signature) throw new Error(`Archived conversations disagree about their working directory: ${location}`);

    return previous;
  }

  if (kind === 'git' && !plan.reused && [...locations.values()].some(item => item.kind === 'git' && item.plan.repositoryRoot === plan.repositoryRoot && item.plan.branch === plan.branch)) plan.branch = `piop-restored-${randomUUID()}`;
  const shared = { kind, plan, signature };
  locations.set(location, shared);

  return shared;
}

function archivedRecoveryRecords(directory) {
  const records = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) records.push(...archivedRecoveryRecords(file));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const record = readArchive(file);

        if (record.header.worktreeRestore) records.push(record);
      } catch { continue; }
    }
  }

  return records;
}

function containsDirectory(parent, child) {
  if (!Check(Type.String(), parent) || !path.isAbsolute(parent)) return false;
  const relative = path.relative(parent, child);

  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function recoveryPlan(locations, record, archived) {
  const failures = [];

  if (record.header.worktreeRestore) {
    try { return sharedPlan(locations, record.header, record.entries); }
    catch (error) {
      if (exists(record.header.cwd)) throw error;
      failures.push(error.message);
    }
  }

  if (exists(record.header.cwd)) {
    if (!fs.statSync(record.header.cwd).isDirectory()) throw new Error('The conversation working directory is no longer a directory');

    return undefined;
  }

  const candidates = archived().filter(candidate => candidate.file !== record.file && containsDirectory(candidate.header.worktreeRestore.path, record.header.cwd))
    .sort((left, right) => right.header.worktreeRestore.path.length - left.header.worktreeRestore.path.length);

  for (const candidate of candidates) {
    try { return sharedPlan(locations, candidate.header, candidate.entries); }
    catch (error) { failures.push(error.message); }
  }

  throw new Error(`No recoverable working directory is available for ${record.header.cwd}${failures.length ? `: ${failures.join('; ')}` : ''}`);
}

function restorationResult(record, shared, destination) {
  return { path: shared?.plan.path ?? shared?.plan.destination ?? record.header.cwd, branch: shared?.plan.branch ?? null, sessionPath: destination };
}

function restoreArchives(files) {
  const records = files.map(readArchive);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const canonicalSessions = fs.realpathSync(sessions);
  const references = referencedPaths(records);
  const destinations = new Set();
  const ids = new Set();
  const locations = new Map();
  let archived;
  const archiveRecords = () => archived ??= archivedRecoveryRecords(fs.realpathSync(path.join(root, 'archived')));

  for (const record of records) {
    const destination = destinationPath(canonicalSessions, record, references);

    if (ids.has(record.header.id) || destinations.has(destination)) throw new Error('Duplicate conversation in restoration');
    ids.add(record.header.id); destinations.add(destination);

    for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.diffs.json'), `${destination}.loop-detection.json`]) absent(target);

    const shared = recoveryPlan(locations, record, archiveRecords);
    record.destination = destination;
    record.result = restorationResult(record, shared, destination);
  }

  const plans = [...locations.values()].filter(item => !item.plan.reused);

  return restoreGroup(root, records, plans.flatMap(item => item.kind === 'directory' ? [item.plan] : []), plans.flatMap(item => item.kind === 'git' ? [item.plan] : []));
}

function main() {
  if (process.argv[1] === '--result') return restoredResult(root, process.argv[2]);
  recover(root);

  if (process.argv[1] === '--recover') return;

  const files = process.argv[1] === '--group' ? JSON.parse(process.argv[2]) : [process.argv[1]];

  if (!Check(Type.Array(Type.String(), { minItems: 1 }), files)) throw new Error('No archived conversations selected');

  return restoreArchives([...new Set(files.map(file => fs.realpathSync(file)))]);
}

if (process.argv.at(-1) !== '--locked') {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = fs.openSync(path.join(root, 'restore.lock'), 'a', 0o600);
  const child = spawnSync('sh', ['-c', 'flock --exclusive 3 || exit $?; exec "$@"', 'piop-restore', process.execPath, ...process.execArgv, '--', ...process.argv.slice(1), '--locked'], { stdio: ['inherit', 'inherit', 'inherit', lock] });
  fs.closeSync(lock);

  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  try { const result = main(); process.stdout.write(JSON.stringify(result ?? null)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
