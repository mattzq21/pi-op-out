const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { exists, restore, restoreGroup, restoredResult, lockStorage } = require('./restore-transaction.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const transactions = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const shared = require('./archive-resource-restore.cjs');
const migration = require('./archive-resource-migration.cjs');

const checkpointSchema = Type.Object({ path: Type.String(), repositoryRoot: Type.String(), ref: Type.String({ pattern: '^refs/pi-session-snapshots/' }), commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }) });

const configuredRoot = process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const root = fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : path.resolve(configuredRoot);

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
  const directory = fs.lstatSync(saved.path, { bigint: true });

  if (!directory.isDirectory()) throw new Error('The archived worktree path is no longer a directory');
  const current = args => execFileSync('git', ['-C', saved.path, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3, 4, 5, 6] }).trim();
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));

  if (fs.realpathSync(current(['rev-parse', '--show-toplevel'])) !== fs.realpathSync(saved.path)
    || fs.realpathSync(current(['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common) throw new Error('The archived worktree path belongs to a different repository');
  let branch = null;

  try { branch = current(['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch (error) { if (error.status !== 1) throw error; }

  return { repositoryRoot: common, path: saved.path, branch, reused: true, directoryIdentity: `${directory.dev}:${directory.ino}` };
}

function worktreePlan(entries, header) {
  const saved = header.worktreeRestore;
  verifyLocation(header, saved);
  const git = args => execFileSync('git', ['-C', saved.repositoryRoot, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3, 4, 5, 6] }).trim();

  if (git(['rev-parse', '--verify', saved.ref]) !== saved.commit) throw new Error('The recovery checkpoint is missing or has changed');
  git(['cat-file', '-e', `${saved.commit}^{commit}`]);
  verifySnapshot(entries, saved);
  const existing = existingWorktree(saved, git);

  if (existing) return existing;

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
  const destination = record.header.archiveSessionPath ?? references.get(record.header.id) ?? path.join(sessions, canonicalTranscriptBasename(record.header));

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

  for (const file of require('./session-database.cjs').paths(root)) {
    if (!containsDirectory(directory, file) || !file.endsWith('.jsonl')) continue;

    try {
      const record = readArchive(file);

      if (record.header.worktreeRestore) records.push(record);
    } catch { continue; }
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

function retainWorkingDirectory(record, shared) {
  if (shared?.kind !== 'git') return;
  const directory = record.header.worktreeRestore?.conversationPath ?? record.header.cwd;

  if (!containsDirectory(shared.plan.path, directory)) throw new Error('The conversation working directory is outside its recovery checkout');
  const relative = path.relative(shared.plan.path, directory);
  shared.plan.conversationDirectories ??= [];

  if (!shared.plan.conversationDirectories.includes(relative)) shared.plan.conversationDirectories.push(relative);
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

    for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json.lock'), `${destination}.loop-detection.json`]) absent(target);

    const shared = record.header.archiveResourceId ? resourcePlan(locations, record, destination) : recoveryPlan(locations, record, archiveRecords);
    retainWorkingDirectory(record, shared);
    record.destination = destination;
    record.result = restorationResult(record, shared, destination);
  }

  const plans = [...locations.values()].filter(item => !item.plan.reused);
  prepareLegacyResources(plans, records);
  const reusedWorktrees = [...locations.values()].flatMap(item => item.kind === 'git' && item.plan.reused ? [item.plan] : []);

  const resources = [...locations.values()].flatMap(item => item.resource ? [item.resource] : []);

  return restoreGroup(root, records, plans.flatMap(item => item.kind === 'directory' && !item.resource ? [item.plan] : []), plans.flatMap(item => item.kind === 'git' ? [item.plan] : []), reusedWorktrees, resources);
}

function prepareLegacyResources(plans, records) {
  for (const selected of plans) {
    if (selected.resource) continue;
    const location = selected.plan.path ?? selected.plan.destination;
    const record = records.find(item => item.header.worktreeRestore?.path === location);

    if (!record) continue;
    const legacy = migration.plan(root, record.file, record.destination, record.header, randomUUID());
    selected.resource = { migration: legacy, receiptId: legacy.operationId,
      result: { sessionId: record.header.id }, trace: { source: record.file, destination: record.destination, identity: transactions.identity(record.file) },
      worktree: selected.kind === 'git' ? selected.plan : undefined };

    if (selected.kind === 'directory') selected.resource.directoryCopy = {
      source: selected.plan.source, destination: selected.plan.destination,
      sourceProof: { identity: legacy.recovery.storedIdentity, directory: true, digest: legacy.recovery.digest, excluded: [] },
      staging: path.join(root, 'restore-staging', legacy.operationId), recovery: path.join(root, 'restore-recovery', legacy.operationId),
    };
  }
}

function restoreArchive(file) {
  const record = readArchive(file);
  const { entries, header } = record;

  if (header.archiveResourceId || !header.worktreeRestore || exists(header.worktreeRestore.path)) return restoreArchives([file]);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const destination = destinationPath(fs.realpathSync(sessions), record, referencedPaths([record]));

  for (const suffix of ['', '.snapshots', '.diffs.json', '.diffs.json.lock']) absent(suffix ? destination.replace(/\.jsonl$/, suffix) : destination);
  absent(`${destination}.loop-detection.json`);
  const saved = header.worktreeRestore;
  const legacy = migration.plan(root, file, destination, header, randomUUID());

  if (saved.kind === 'directory') {
    const planned = directoryPlan(saved);

    const resource = { migration: legacy, directoryCopy: { ...planned, sourceProof: { identity: legacy.recovery.storedIdentity, directory: true, digest: legacy.recovery.digest, excluded: [] },
      staging: path.join(root, 'restore-staging', legacy.operationId), recovery: path.join(root, 'restore-recovery', legacy.operationId) } };

    return restore(root, header, file, destination, { path: saved.path, branch: null, sessionPath: destination }, undefined, undefined, resource);
  }

  const worktree = worktreePlan(entries, header);
  retainWorkingDirectory(record, { kind: 'git', plan: worktree });

  return restore(root, header, file, destination, { path: saved.path, branch: worktree.branch, sessionPath: destination }, undefined, worktree, { migration: legacy });
}

function resourceWorktree(resource) {
  const saved = resource.recovery;
  const location = resource.binding.path;

  if (resource.action === 'create-git') return {
    repositoryRoot: saved.repositoryRoot, path: location, commit: saved.commit,
    branch: restoredBranch(saved, args => transactions.git(saved.repositoryRoot, args)),
    staging: path.join(path.dirname(location), `.piop-restore-${randomUUID()}`), reservation: `refs/piop-restore-transactions/${randomUUID()}`,
  };
  let branch = null;

  try { branch = transactions.git(location, ['symbolic-ref', '--short', '--quiet', 'HEAD']); }
  catch (error) { if (error.status !== 1) throw error; }

  return { path: location, repositoryRoot: resource.binding.git.root, branch, reused: true, directoryIdentity: resource.binding.identity, conversationDirectories: [] };
}

function combineResource(previous, planned, record, destination) {
  if (previous.resource.resource.before !== planned.change.before) throw new Error('Shared archive ownership changed during group planning');
  const after = JSON.parse(previous.resource.resource.after);
  const selected = JSON.parse(planned.change.after).owners.find(owner => owner.sessionId === record.header.id && owner.sessionPath === destination);
  const index = after.owners.findIndex(owner => owner.sessionId === record.header.id && owner.sessionPath === record.file);

  if (!selected || index < 0) throw new Error('Shared archive group owner could not be verified');
  after.owners[index] = selected;
  previous.resource.resource.after = JSON.stringify(after);

  return previous;
}

function resourcePlan(locations, record, destination) {
  const planned = shared.plan(root, record.file, destination, randomUUID());
  const location = planned.binding.path;
  const previous = locations.get(location);

  if (previous) {
    if (!previous.resource || previous.resource.resource.resourceId !== planned.change.resourceId) throw new Error('Archived conversations disagree about shared working directory ownership');

    return combineResource(previous, planned, record, destination);
  }

  const kind = planned.binding.git ? 'git' : 'directory';
  const plan = kind === 'git' ? resourceWorktree(planned) : { destination: location, reused: planned.action === 'reuse' };

  const resource = { resource: planned.change, receiptId: planned.change.operationId, directoryCopy: planned.directoryCopy,
    worktree: kind === 'git' && !plan.reused ? plan : undefined,
    result: { sessionId: record.header.id }, trace: { source: record.file, destination, identity: planned.sourceIdentity } };

  const selected = { kind, plan, resource };
  locations.set(location, selected);

  return selected;
}

function main() {
  transactions.recover(root);
  recoverStorage(root);

  if (process.argv[1] === '--result') return restoredResult(root, process.argv[2]);

  if (process.argv[1] === '--recover') return;

  const files = process.argv[1] === '--group' ? JSON.parse(process.argv[2]) : [process.argv[1]];

  if (!Check(Type.Array(Type.String(), { minItems: 1 }), files)) throw new Error('No archived conversations selected');

  const selected = [...new Set(files.map(file => fs.realpathSync(file)))];

  return selected.length === 1 ? restoreArchive(selected[0]) : restoreArchives(selected);
}

try {
  if (lockStorage(root)) process.stdout.write(JSON.stringify(main() ?? null));
} catch (error) { console.error(error.message); process.exitCode = 1; }
