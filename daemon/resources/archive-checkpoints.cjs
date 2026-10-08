const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const owners = require('./transaction-owner-locks.cjs');
const resources = require('./archive-resources.cjs');
const checkpoints = require('./worktree-checkpoint-preservation.cjs');
const diffs = require('./session-broker/git-diff-store.cjs');
const checkpointIndex = require('./session-broker/checkpoint-owner-index.cjs');

function targets(transaction) {
  return transaction.groups.filter(group => group.kind === 'git').map(group => ({ path: group.path, common: group.common, identity: group.identity.identity }));
}

function peerIds(transaction) {
  return transaction.groups.flatMap(group => group.resource ? resources.headerUpdates(transaction.root, group.resource.change).map(update => update.sessionId) : []);
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

function checkGlobalDiffs(links, worktrees) {
  for (const { file, kind } of links) {
    if (kind !== 'pointer') continue;

    const record = require('./session-database.cjs').pendingDiff(path.dirname(file));

    if (record === undefined) continue;

    if (worktrees.some(target => captureUses(record.capture, target))) throw new Error('Pending comparison recovery requires the archived worktree: ' + file);
  }
}

function scan(transaction, links) {
  const records = [];
  const worktrees = targets(transaction);
  const resourceOwners = new Set(peerIds(transaction));

  for (const link of links) {
    const record = readLinked(transaction.root, link, worktrees);

    if (record) records.push(record);
  }

  for (const record of records) for (const target of worktrees) map(record, target, resourceOwners);
  checkGlobalDiffs(links, worktrees);

  return records.sort((left, right) => left.file.localeCompare(right.file));
}

function readLinked(root, link, worktrees) {
  if (link.kind === 'diff') {
    for (const target of worktrees) checkDiffs(link.file.replace(/\.diffs\.json$/, '.jsonl'), target);

    return;
  }

  if (link.kind !== 'transcript' || !io.exists(link.file)) return;
  const archived = io.inside(path.join(root, 'archived'), link.file);

  if (!archived && !io.inside(path.join(root, 'sessions'), link.file)) throw new Error('Checkpoint owner index points outside conversation storage');
  const record = read(link.file, archived);

  if (record.header.id !== link.sessionId) throw new Error('Checkpoint owner index identity changed');

  return record;
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
  checkpointIndex.refresh(record.file);
}

function validate(transaction) {
  for (const mapping of transaction.checkpointMappings ?? []) {
    if (!['sessions', 'archived'].some(area => io.inside(path.join(transaction.root, area), mapping.file)) || !mapping.file.endsWith('.jsonl')) throw new Error('Invalid archive checkpoint owner mapping');

    if (path.dirname(mapping.prepared) !== transaction.container || !/^checkpoint-[a-f0-9-]{36}\.prepared$/.test(path.basename(mapping.prepared))) throw new Error('Invalid checkpoint publication staging ownership');
  }
}

function preserve(transaction, borrowedIds, operation) {
  const worktrees = targets(transaction).map(target => target.path);
  const initial = checkpointIndex.linked(transaction.root, worktrees);
  const ids = [...initial.map(link => link.sessionId), ...peerIds(transaction), ...transaction.records.map(record => record.sessionId)];

  return owners.withOwners(transaction.root, ids, borrowedIds, () => {
    const links = checkpointIndex.linked(transaction.root, worktrees);

    if (JSON.stringify(initial) !== JSON.stringify(links)) throw new Error('Checkpoint owner links changed before archive preservation; retry');
    const locked = scan(transaction, links);
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
