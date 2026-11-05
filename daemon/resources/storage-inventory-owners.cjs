const path = require('node:path');
const { addRoot } = require('./storage-inventory-roots.cjs');

const safeId = value => value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

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

  return 'referenced';
}

module.exports = { recordSession, resolveOwners, sessionKind };
