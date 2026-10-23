const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { addRoot, legacyRecovery } = require('./storage-inventory-roots.cjs');
const { validGoalPath, observeGoalContract } = require('./storage-inventory-goals.cjs');

const safeId = value => value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

function observeEntry(observation, entry) {
  observeGoals(observation, entry);
  observeGoalContract(observation, entry);
}

function observeGoals(observation, entry) {
  if (!['custom', 'custom_message'].includes(entry.type) || entry.customType !== 'piop-goal-context') return;
  const objective = entry.data?.objective;
  const text = Check(Type.String(), objective) ? objective : JSON.stringify(entry.content ?? entry.data);

  if (!text) return;

  for (const match of text.matchAll(/(\/[^"\n]*?\/attachments\/goal-[a-zA-Z0-9_-]+)(?=\/)/g)) observation.goals.add(match[1]);
}

function createObservation() { return { goals: new Set(), goalContracts: new Map(), goalWarnings: [] }; }

function recordSession(discovery, details, candidate, root) {
  const id = details.sessionId;
  const kind = details.readable ? candidate.kind : 'unresolved';
  const owner = { sessionId: id || path.basename(candidate.file, '.jsonl'), sessionPath: candidate.file, kind };
  const source = `${kind} conversation: ${candidate.file}`;

  if (id && details.readable) {
    if (!discovery.sessions.has(id)) discovery.sessions.set(id, []);
    discovery.sessions.get(id).push(owner);
    discovery.headers.set(candidate.file, { id, cwd: details.cwd });
  }

  addRoot(discovery.cwds, details.cwd, source, 'referenced', [owner]);

  if (legacyRecovery(details.cwd || '')) {
    const root = path.basename(details.cwd) === 'workdir' ? path.dirname(details.cwd) : details.cwd;
    addRoot(discovery.legacy, root, source, 'unattributed', [owner]);
  }

  recordGoals(discovery, details, owner, candidate);
}

function recordGoals(discovery, details, owner, candidate) {
  let kind = 'unresolved';

  if (details.readable) kind = details.fork ? 'fork-history' : `${candidate.kind}-goal-history`;

  if (candidate.kind.startsWith('diagnostic-')) kind = candidate.kind;
  const goalOwner = { ...owner, kind };
  const source = candidate.kind.startsWith('diagnostic-') ? 'Retained diagnostic reference; not a live owner: ' : 'Goal reference in surviving history: ';

  for (const warning of details.observation.goalWarnings) discovery.warnings.push(candidate.file + ': ' + warning);

  for (const directory of details.observation.goals) {
    const record = addRoot(discovery.goals, directory, source + candidate.file, 'shared', [goalOwner]);
    const identities = details.observation.goalContracts.get(directory);

    if (identities) { record.contracts ??= []; record.contracts.push({ owner: goalOwner, identities }); }
  }
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

function sessionKind(file, profile) {
  const relative = path.relative(profile, file).split(path.sep);

  if (relative[0] === 'sessions') return 'active';

  if (relative[0] === 'archived') return 'archived';

  return 'referenced';
}

module.exports = { createObservation, observeEntry, recordSession, recordGoals, resolveOwners, sessionKind, validGoalPath };
