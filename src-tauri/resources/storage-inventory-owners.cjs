const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { absolute, addRoot, legacyRecovery } = require('./storage-inventory-roots.cjs');
const { snapshotCheckpoint, promptCheckpoint } = require('./checkpoint-schemas.cjs');

const safeId = value => value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

function observeEntry(observation, entry) {
  for (const root of [entry.checkpointRepositoryRoot, entry.worktreeRestore?.repositoryRoot, entry.data?.repositoryRoot]) {
    if (absolute(root)) observation.repositories.add(root);
  }

  if (snapshotCheckpoint(entry.data)) observation.refs.set(entry.data.ref, entry.data.commit);

  if (snapshotCheckpoint(entry.worktreeRestore)) observation.refs.set(entry.worktreeRestore.ref, entry.worktreeRestore.commit);

  observePrompt(observation, entry);
  observeGoals(observation, entry);
}

function observePrompt(observation, entry) {
  if (entry.customType !== 'pi-project-prompt-checkpoint' || !promptCheckpoint(entry.data)) return;
  observation.refs.set(`refs/pi-session-snapshots/chats/${safeId(entry.data.owner)}/prompts/${entry.data.key}`, entry.data.commit);
}

function observeGoals(observation, entry) {
  if (!['custom', 'custom_message'].includes(entry.type) || !['piop-goal', 'piop-goal-context'].includes(entry.customType)) return;
  const objective = entry.data?.objective;
  const text = Check(Type.String(), objective) ? objective : JSON.stringify(entry.content ?? entry.data);

  if (!text) return;

  for (const match of text.matchAll(/(\/[^"\n]*?\/attachments\/goal-[a-zA-Z0-9_-]+)(?=\/)/g)) observation.goals.add(match[1]);
}

function createObservation() { return { repositories: new Set(), refs: new Map(), goals: new Set() }; }

function recordSession(discovery, details, candidate) {
  const id = details.sessionId;
  const kind = details.readable ? candidate.kind : 'unresolved';
  const owner = { sessionId: id || path.basename(candidate.file, '.jsonl'), sessionPath: candidate.file, kind };
  const source = `${kind} conversation: ${candidate.file}`;

  if (id && details.readable) {
    if (!discovery.sessions.has(id)) discovery.sessions.set(id, []);
    discovery.sessions.get(id).push(owner);
    discovery.headers.set(candidate.file, { id, cwd: details.cwd });
  }

  recordRepositories(discovery, details, owner, source);
  addRoot(discovery.cwds, details.cwd, source, 'referenced', [owner]);

  if (legacyRecovery(details.cwd || '')) {
    const root = path.basename(details.cwd) === 'workdir' ? path.dirname(details.cwd) : details.cwd;
    addRoot(discovery.legacy, root, source, 'unattributed', [owner]);
  }

  recordGoals(discovery, details, owner, candidate);
}

function recordRepositories(discovery, details, owner, source) {
  if (absolute(details.cwd)) {
    const existing = discovery.repositories.has(details.cwd);
    const record = addRoot(discovery.repositories, details.cwd, `${source}; cwd repository candidate`, 'referenced', [owner]);

    if (!existing) record.optionalRepository = true;
  }

  for (const root of details.observation.repositories) {
    const record = addRoot(discovery.repositories, root, source, 'referenced', [owner]);
    record.optionalRepository = false;

    if (!record.recordedRefs) record.recordedRefs = new Map();

    if (details.readable) recordRefs(record, details.observation.refs, owner);
  }

  if (details.readable && absolute(details.cwd)) {
    const record = discovery.repositories.get(details.cwd);

    if (!record.recordedRefs) record.recordedRefs = new Map();
    recordRefs(record, details.observation.refs, owner);
  }
}

function recordRefs(record, refs, owner) {
  for (const [ref, commit] of refs) {
    if (!record.recordedRefs.has(ref)) record.recordedRefs.set(ref, []);
    record.recordedRefs.get(ref).push({ commit, owner });
  }
}

function recordGoals(discovery, details, owner, candidate) {
  let kind = 'unresolved';

  if (details.readable) kind = details.fork ? 'fork-history' : `${candidate.kind}-goal-history`;
  const goalOwner = { ...owner, kind };

  for (const directory of details.observation.goals) addRoot(discovery.goals, directory, `Goal reference in surviving history: ${candidate.file}`, 'shared', [goalOwner]);
}

function resolveOwners(discovery) {
  for (const record of discovery.recovery.values()) {
    record.owners = record.owners.map(owner => recoveryOwner(owner, record, discovery));
    const references = discovery.cwds.get(record.workdir)?.owners || [];

    for (const owner of references) {
      if (owner.kind !== 'unresolved') addRoot(discovery.recovery, record.path, 'Surviving transcript header references this recovery workdir', record.ownership, [{ ...owner, kind: `${owner.kind}-current-directory` }]);
    }

    if (record.ownership === 'owned' && !record.owners.some(owner => owner.kind !== 'unresolved')) discovery.warnings.push(`${record.path}: recovery ownership provenance could not be reconciled with surviving transcript headers; retained`);
  }
}

function recoveryOwner(owner, record, discovery) {
  const matching = (discovery.sessions.get(safeId(owner.sessionId)) || []).find(session => {
    const cwd = discovery.headers.get(session.sessionPath)?.cwd;

    return cwd === record.workdir || cwd === record.originalCwd;
  });

  if (!matching) return { ...owner, kind: 'unresolved' };
  const cwd = discovery.headers.get(matching.sessionPath)?.cwd;

  return { ...matching, kind: `${matching.kind}-${cwd === record.workdir ? 'current-directory' : 'retained-recovery'}` };
}

function checkpointOwners(ref, oid, records, sessions) {
  const owners = [];

  for (const record of records) {
    for (const match of record.recordedRefs?.get(ref) || []) {
      if (match.commit === oid) owners.push(match.owner);
    }
  }

  const match = /^refs\/pi-session-snapshots\/chats\/([^/]+)\//.exec(ref)
    || /^refs\/pi-session-snapshots\/([^/]+)$/.exec(ref);

  if (match) owners.push(...sessions.get(match[1]) || []);

  return owners;
}

function ownerCategory(owners) {
  if (owners.some(owner => ['active', 'ephemeral'].includes(owner.kind))) return 'project-checkpoints';

  if (owners.some(owner => owner.kind === 'archived')) return 'archived-project-checkpoints';

  return 'unattributed-project-checkpoints';
}

function sessionKind(file, profile) {
  const relative = path.relative(profile, file).split(path.sep);

  if (relative[0] === 'sessions') return 'active';

  if (relative[0] === 'archived') return 'archived';

  if (/^pi-desktop-btw-[a-f0-9-]{36}\.jsonl$/.test(path.basename(file))) return 'ephemeral';

  return 'referenced';
}

function validGoalPath(directory) { return absolute(directory) && /^goal-[a-zA-Z0-9_-]+$/.test(path.basename(directory)) && path.basename(path.dirname(directory)) === 'attachments'; }

module.exports = { createObservation, observeEntry, recordSession, resolveOwners, checkpointOwners, ownerCategory, sessionKind, validGoalPath };
