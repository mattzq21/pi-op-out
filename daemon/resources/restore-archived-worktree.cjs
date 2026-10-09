const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { exists, restoreGroup, restoredResult, lockStorage } = require('./restore-transaction.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const transactions = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const shared = require('./archive-resource-restore.cjs');

const configuredRoot = process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

const root = fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : path.resolve(configuredRoot);

function absent(file) {
  if (exists(file)) throw new Error(`Restoration destination already exists: ${file}`);
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

function containsDirectory(parent, child) {
  if (!Check(Type.String(), parent) || !path.isAbsolute(parent)) return false;
  const relative = path.relative(parent, child);

  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
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

  for (const record of records) {
    const destination = destinationPath(canonicalSessions, record, references);

    if (ids.has(record.header.id) || destinations.has(destination)) throw new Error('Duplicate conversation in restoration');
    ids.add(record.header.id); destinations.add(destination);

    for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots'), `${destination}.loop-detection.json`]) absent(target);

    const shared = record.header.archiveResourceId ? resourcePlan(locations, record, destination) : existingDirectory(record);
    retainWorkingDirectory(record, shared);
    record.destination = destination;
    record.result = restorationResult(record, shared, destination);
  }

  const plans = [...locations.values()].filter(item => !item.plan.reused);
  const reusedWorktrees = [...locations.values()].flatMap(item => item.kind === 'git' && item.plan.reused ? [item.plan] : []);

  const resources = [...locations.values()].flatMap(item => item.resource ? [item.resource] : []);

  return restoreGroup(root, records, plans.flatMap(item => item.kind === 'directory' && !item.resource ? [item.plan] : []), plans.flatMap(item => item.kind === 'git' ? [item.plan] : []), reusedWorktrees, resources);
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

  return restoreArchives(selected);
}

try {
  if (lockStorage(root)) process.stdout.write(JSON.stringify(main() ?? null));
} catch (error) { console.error(error.message); process.exitCode = 1; }

function existingDirectory(record) {
  if (!exists(record.header.cwd) || !fs.statSync(record.header.cwd).isDirectory()) throw new Error('The working directory is unavailable and no archive resource is registered');
}
