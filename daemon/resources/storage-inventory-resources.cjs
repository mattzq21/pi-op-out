const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { list, planRestore } = require('./archive-resources.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const { addRoot } = require('./storage-inventory-roots.cjs');

function sharedArchiveRestore(profile, file, header) {
  try {
    const destination = path.join(profile, 'sessions', canonicalTranscriptBasename(header));
    const planned = planRestore(profile, file, destination, randomUUID());

    if (planned.sessionId !== header.id) throw new Error('Archived session identity changed during resource inspection');
    const metadata = { restorable: true };

    if (planned.binding.git && planned.action === 'reuse') metadata.worktreePath = planned.binding.path;

    return metadata;
  } catch (error) { return { restorable: false, restoreError: 'Shared archive recovery unavailable: ' + error.message }; }
}

function owners(record) {
  return record.owners.map(owner => ({ sessionId: owner.sessionId, sessionPath: owner.sessionPath ?? undefined, kind: 'archive-resource-' + owner.area + '-provenance' }));
}

function storedCopies(loaded, discovery, provenance) {
  for (const stored of loaded.record.storage) {
    const record = addRoot(discovery.retainedArtifacts, stored.path, provenance + '; declared stored digest: ' + stored.digest + '; ledger owners are provenance, not current liveness', 'shared', owners(loaded.record));
    record.category = 'archived-worktrees';
    record.expectedIdentity = stored.identity;
    record.state = 'resource-' + loaded.record.state;
  }
}

async function resourceNamespace(profile, discovery) {
  const directory = path.join(profile, 'archive-resources');

  try {
    const metadata = await fs.lstat(directory);

    if (!metadata.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Shared resource ledger namespace has ambiguous ancestry');
    const record = addRoot(discovery.retainedArtifacts, directory, 'Shared archive resource ledgers; regular files counted in other storage', 'owned');
    record.category = 'other-storage';
  } catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(directory + ': shared resource ledger coverage unavailable: ' + error.message); }
}

async function discoverArchiveResources(profile, discovery) {
  legacyStoredCopies(profile, discovery);
  await resourceNamespace(profile, discovery);
  let resources;

  try { resources = list(profile); }
  catch (error) {
    discovery.warnings.push(profile + ': shared archive resource provenance unavailable: ' + error.message + '; stored data and pins retained');

    return;
  }

  for (const loaded of resources) {
    const provenance = 'Shared archive resource ' + loaded.record.id + '; state: ' + loaded.record.state + '; stored in SQLite';
    const record = addRoot(discovery.retainedArtifacts, path.join(profile, 'sessions.sqlite'), provenance + '; durable owners are provenance, not live counts', 'owned', owners(loaded.record));
    record.category = 'other-storage';
    record.state = 'shared-archive-records';
    record.pins = [...record.pins ?? [], ...loaded.record.pins];
    storedCopies(loaded, discovery, provenance);
  }
}

function legacyStoredCopies(profile, discovery) {
  for (const [file, header] of discovery.headers) {
    const directory = header.archivedDirectory;

    if (!directory) continue;

    if (path.dirname(directory) !== path.join(profile, 'archived-tmp') || path.normalize(directory) !== directory) {
      discovery.warnings.push(`${file}: saved archive directory is outside archive storage`);
      continue;
    }

    const record = addRoot(discovery.retainedArtifacts, directory, 'Saved conversation archive location', 'referenced', [{ sessionId: header.id, sessionPath: file, kind: 'archive-directory-reference' }]);
    record.category = 'archived-worktrees';
  }
}

module.exports = { sharedArchiveRestore, discoverArchiveResources };
