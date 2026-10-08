const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const owners = require('./transaction-owner-locks.cjs');
const resources = require('./archive-resources.cjs');
const checkpoints = require('./worktree-checkpoint-preservation.cjs');
const diffs = require('./session-broker/git-diff-store.cjs');

function targets(transaction) {
  return transaction.groups.filter(group => group.kind === 'git').map(group => ({ path: group.path, common: group.common, identity: group.identity.identity }));
}

function peerIds(transaction) {
  return transaction.groups.flatMap(group => group.resource ? resources.headerUpdates(transaction.root, group.resource.change).map(update => update.sessionId) : []);
}

function walk(directory, archived, records) {
  if (!io.exists(directory)) return;

  if (fs.realpathSync(directory) !== directory) throw new Error('Checkpoint owner storage has ambiguous ancestry');

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots') && entry.name !== 'attachments') walk(file, archived, records);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) records.push(read(file, archived));
  }
}

function read(file, archived) {
  if (fs.realpathSync(file) !== file) throw new Error('Checkpoint owner path has ambiguous ancestry');
  const original = io.describe(file);
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
  const header = entries[0];

  if (header?.type !== 'session' || !header.id || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid historical checkpoint owner: ' + file);

  if (!io.matches(file, original)) throw new Error('Historical checkpoint owner changed while reading');

  return { file, archived, original, entries, header, refs: [], changed: false, mode: fs.statSync(file).mode & 0o777 };
}

function map(record, target, resourceOwners) {
  checkDiffs(record.file, target);

  if (!io.exists(target.path)) {
    if (usesCheckpointRoot(record, target)) throw new Error('A historical owner still references the removed archive path; recovery retained: ' + record.file);

    return;
  }

  if (io.identity(target.path) !== target.identity) throw new Error('The original archive directory was replaced; historical data retained');
  const mapped = checkpoints.remapCheckpointRoots(record.header, record.entries, record.archived && !resourceOwners.has(record.header.id), target.path, target.common);
  record.changed ||= mapped.changed;
  record.refs.push(...mapped.refs.map(ref => ({ ...ref, common: target.common })));

  if (remapHeader(record.header, target)) record.changed = true;
}

function remapHeader(header, target) {
  if (!io.inside(target.path, header.checkpointRepositoryRoot ?? '')) return false;

  if (checkpoints.canonicalRepository(header.checkpointRepositoryRoot) !== target.common) throw new Error('Historical checkpoint header belongs to another repository; retained');

  header.checkpointRepositoryRoot = target.common;

  return true;
}

function usesCheckpointRoot(record, target) {
  if (io.inside(target.path, record.header.checkpointRepositoryRoot ?? '')) return true;

  if (record.header.worktreeRestore?.kind === 'git' && io.inside(target.path, record.header.worktreeRestore.repositoryRoot ?? '')) return true;

  return record.entries.some(entry => entryUsesRoot(entry, record.header, target));
}

function entryUsesRoot(entry, header, target) {
  if (entry.type !== 'custom' || !['pi-project-files-watch-snapshot', 'pi-project-prompt-checkpoint'].includes(entry.customType)) return false;

  if (!io.inside(target.path, entry.data?.repositoryRoot ?? '')) return false;

  if (entry.data.unavailable !== true) return true;
  const id = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';
  const ref = entry.customType === 'pi-project-prompt-checkpoint' ? `refs/pi-session-snapshots/chats/${id}/prompts/${entry.data.key}` : entry.data.ref;

  return Boolean(ref && io.refValue(target.common, ref));
}

function captureUses(capture, target) {
  if (capture.ready === true) return false;

  if (io.inside(target.path, capture.cwd ?? '')) return true;

  return [capture.baseline, capture.current].some(token => token && io.inside(target.path, JSON.parse(token).repository_root ?? ''));
}

function checkDiffs(file, target) {
  const log = file.replace(/\.jsonl$/, '.diffs.json');

  if (!io.exists(log)) return;
  const state = owners.withFile(log + '.lock', () => diffs.readStore(log, false));

  if (Object.values(state.pending).some(capture => captureUses(capture, target))) throw new Error('Pending diff comparisons require the archived worktree; recovery retained: ' + log);
}

function checkGlobalDiffs(root, worktrees) {
  const directory = path.join(root, 'git-snapshots');

  if (!io.exists(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('pi-desktop-diff-')) continue;
    const file = path.join(directory, entry.name, 'pending-diff.json');

    if (!io.exists(file)) continue;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    try {
      if (fs.fstatSync(descriptor).size > 4 * 1024 * 1024 * 6 + 64 * 1024) throw new Error('Oversized pending comparison retained');
      const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));

      if (worktrees.some(target => captureUses(record.capture, target))) throw new Error('Pending comparison recovery requires the archived worktree: ' + file);
    } finally { fs.closeSync(descriptor); }
  }
}

function scan(transaction) {
  const records = [];
  const worktrees = targets(transaction);
  const resourceOwners = new Set(peerIds(transaction));
  walk(path.join(transaction.root, 'sessions'), false, records);
  walk(path.join(transaction.root, 'archived'), true, records);

  for (const record of records) for (const target of worktrees) map(record, target, resourceOwners);
  checkGlobalDiffs(transaction.root, worktrees);

  return records.sort((left, right) => left.file.localeCompare(right.file));
}

function verifyPlan(before, after) {
  if (before.length !== after.length || before.some((record, index) => record.file !== after[index].file || record.original.identity !== after[index].original.identity || record.original.digest !== after[index].original.digest)) throw new Error('Historical owners changed before archive preservation; retry');
}

function save(transaction) { io.write(path.join(transaction.container, 'recovery.json'), JSON.stringify(transaction)); }

function publish(transaction, record) {
  for (const ref of record.refs) checkpoints.verifyCheckpoint(ref.common, ref.ref, ref.commit);

  const planned = { file: record.file, sessionId: record.header.id, original: record.original,
    prepared: path.join(transaction.container, 'checkpoint-' + randomUUID() + '.prepared'), refs: record.refs };

  transaction.checkpointMappings ??= [];
  transaction.checkpointMappings.push(planned);

  save(transaction);

  fs.writeFileSync(planned.prepared, record.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: record.mode });
  io.syncTree(planned.prepared);
  planned.preparedIdentity = io.describe(planned.prepared);
  save(transaction);

  if (!io.matches(record.file, record.original)) throw new Error('Historical checkpoint owner changed before publication; temporary retained');
  fs.renameSync(planned.prepared, record.file);
  io.sync(path.dirname(record.file));
}

function validate(transaction) {
  for (const mapping of transaction.checkpointMappings ?? []) {
    if (!['sessions', 'archived'].some(area => io.inside(path.join(transaction.root, area), mapping.file)) || !mapping.file.endsWith('.jsonl')) throw new Error('Invalid archive checkpoint owner mapping');

    if (path.dirname(mapping.prepared) !== transaction.container || !/^checkpoint-[a-f0-9-]{36}\.prepared$/.test(path.basename(mapping.prepared))) throw new Error('Invalid checkpoint publication staging ownership');
  }
}

function preserve(transaction, borrowedIds, operation) {
  const initial = scan(transaction);
  const affected = initial.filter(record => record.changed).map(record => record.header.id);
  const ids = [...affected, ...peerIds(transaction), ...transaction.records.map(record => record.sessionId)];

  return owners.withOwners(transaction.root, ids, borrowedIds, () => {
    const locked = scan(transaction);
    verifyPlan(initial, locked);
    const selected = new Set(transaction.records.map(record => record.file));

    for (const record of locked.filter(record => record.changed && !selected.has(record.file))) publish(transaction, record);

    return operation();
  });
}

function remapSelected(record, group) {
  checkpoints.remapCheckpointRoots(record.header, record.entries, false, group.path, group.common);
  remapHeader(record.header, group);
}

module.exports = { preserve, remapSelected, validate };
