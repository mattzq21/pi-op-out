const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { exists, restore, restoredResult } = require('./restore-transaction.cjs');
const transactions = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const shared = require('./archive-resource-restore.cjs');
const migration = require('./archive-resource-migration.cjs');

const checkpointSchema = Type.Object({ path: Type.String(), repositoryRoot: Type.String(), ref: Type.String({ pattern: '^refs/pi-session-snapshots/' }), commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }) });

const configuredRoot = process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

let root;

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

function worktreePlan(entries, header) {
  const saved = header.worktreeRestore;
  verifyLocation(header, saved);
  const git = args => execFileSync('git', ['-C', saved.repositoryRoot, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3] }).trim();

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
  const storage = fs.realpathSync(path.join(root, 'archived-tmp'));
  const stored = fs.realpathSync(saved.storedPath);

  if (path.dirname(stored) !== storage || !path.isAbsolute(saved.path ?? '') || !fs.lstatSync(stored).isDirectory()) throw new Error('Invalid archived directory');
  absent(saved.path);

  return { source: stored, destination: saved.path };
}

function readArchive(file) {
  const archive = fs.realpathSync(path.join(root, 'archived'));

  if (!file.startsWith(archive + path.sep) || !file.endsWith('.jsonl')) throw new Error('Only archived conversations can restore worktrees');
  const entries = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => line.trim() ? [JSON.parse(line)] : []);
  const header = entries[0];

  if (header?.type !== 'session' || !Check(Type.String({ minLength: 1 }), header.id) || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid archived session header');

  return { entries, header };
}

function restoreArchive(file) {
  const { entries, header } = readArchive(file);
  const basename = canonicalTranscriptBasename(header);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });

  const destination = path.join(fs.realpathSync(sessions), basename);

  for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json.lock'), `${destination}.loop-detection.json`]) absent(target);

  if (header.archiveResourceId) return restoreShared(header, file, destination);
  const saved = header.worktreeRestore;

  if (!saved) {
    if (!exists(header.cwd)?.isDirectory()) throw new Error('Legacy archive has no verified directory recovery descriptor; missing contents remain unavailable and require explicit recovery');

    return restore(root, header, file, destination, { path: header.cwd, branch: null, sessionPath: destination });
  }

  const legacy = migration.plan(root, file, destination, header, randomUUID());

  if (saved.kind === 'directory') {
    const planned = directoryPlan(saved);

    const resource = { migration: legacy, directoryCopy: { ...planned, sourceProof: { identity: legacy.recovery.storedIdentity, directory: true, digest: legacy.recovery.digest, excluded: [] },
      staging: path.join(root, 'restore-staging', legacy.operationId), recovery: path.join(root, 'restore-recovery', legacy.operationId) } };

    return restore(root, header, file, destination, { path: saved.path, branch: null, sessionPath: destination }, undefined, undefined, resource);
  }

  const worktree = worktreePlan(entries, header);

  return restore(root, header, file, destination, { path: saved.path, branch: worktree.branch, sessionPath: destination }, undefined, worktree, { migration: legacy });
}

function restoreShared(header, file, destination) {
  const resource = shared.plan(root, file, destination, randomUUID());
  const saved = resource.recovery;
  let worktree;
  let branch = null;

  if (resource.action === 'create-git') {
    const git = args => transactions.git(saved.repositoryRoot, args);
    branch = restoredBranch(saved, git);
    worktree = { repositoryRoot: saved.repositoryRoot, path: saved.path, commit: saved.commit, branch,
      staging: path.join(path.dirname(saved.path), `.piop-restore-${randomUUID()}`), reservation: `refs/piop-restore-transactions/${randomUUID()}` };
  } else if (resource.binding.git) {
    try { branch = transactions.git(resource.binding.path, ['symbolic-ref', '--short', '--quiet', 'HEAD']); }
    catch (error) { if (error.status !== 1) throw error; }
  }

  return restore(root, header, file, destination, { path: resource.binding.path, branch, sessionPath: destination }, undefined, worktree, resource);
}

function main() {
  transactions.recover(root);

  if (process.argv[1] === '--result') return restoredResult(root, process.argv[2]);

  if (process.argv[1] === '--recover') return;

  return restoreArchive(fs.realpathSync(process.argv[1]));
}

try {
  if (transactions.lock(fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : path.resolve(configuredRoot))) {
    root = fs.realpathSync(configuredRoot);
    const result = main();
    process.stdout.write(JSON.stringify(result ?? null));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
