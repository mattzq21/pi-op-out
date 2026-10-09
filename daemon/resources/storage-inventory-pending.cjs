const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { addRoot, absolute } = require('./storage-inventory-roots.cjs');
const { readStore } = require('./session-broker/git-diff-store.cjs');
const { discoverTransfers } = require('./storage-inventory-transfers.cjs');

const tokenSchema = Type.Object({ root: Type.String(), repository_root: Type.String(), tree: Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }) });

const captureSchema = Type.Object({ baseline: Type.String(), current: Type.String() });

const pointerSchema = Type.Object({ sessionId: Type.String(), id: Type.String(), capture: captureSchema });

function pendingRoot(token, owner, source, capture, profile, discovery) {
  const value = JSON.parse(token);

  if (!Check(tokenSchema, value) || !absolute(value.root) || !/^pi-desktop-diff-/.test(path.basename(value.root))) throw new Error('Pending comparison token has invalid root provenance');
  const ownership = path.dirname(value.root) === path.join(profile, 'git-snapshots') ? 'owned' : 'unattributed';
  const record = addRoot(discovery.pendingSnapshots, value.root, `Pending comparison reference in ${source}; tree: ${value.tree}`, ownership, [owner]);
  record.state = capture.failure?.kind === 'permanent' ? 'pending-permanent-limit' : 'pending-recovery';
  addRoot(discovery.repositories, value.repository_root, `Pending comparison in ${source}`, 'referenced', [owner]);

  if (capture.failure?.message) discovery.warnings.push(`${source}: comparison retained: ${capture.failure.message}`);
}

function pendingCapture(capture, owner, source, profile, discovery) {
  if (capture?.source === 'copy') return;

  if (!Check(captureSchema, capture)) throw new Error('Pending comparison metadata is incomplete');

  for (const token of [capture.baseline, capture.current]) pendingRoot(token, owner, source, capture, profile, discovery);
}

async function pointer(directory, profile, discovery) {
  const file = path.join(directory, 'pending-diff.json');

  try {
    const record = require('./session-database.cjs').pendingDiff(directory);

    if (record === undefined) return;

    if (!Check(pointerSchema, record)) throw new Error('Invalid global pending comparison pointer');
    const owner = { sessionId: record.sessionId, kind: 'pending-comparison-pointer-provenance' };
    pendingCapture(record.capture, owner, file, profile, discovery);
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${file}: global pending comparison ownership unavailable: ${error.message}; snapshots retained`);
  }
}

async function discoverPendingSnapshots(profile, discovery) {
  for (const row of require('./session-database.cjs').snapshotDirectories(profile)) {
    if (path.dirname(row.directory) === path.join(profile, 'git-snapshots') && path.basename(row.directory).startsWith('pi-desktop-diff-')) await pointer(row.directory, profile, discovery);
  }
}

function discoverPendingLogs(profile, discovery) {
  for (const [file, header] of discovery.headers) {
    const sidecar = file.replace(/\.jsonl$/, '.diffs.json');

    try {
      const state = readStore(sidecar, false);
      const owner = { sessionId: header.id, sessionPath: file, kind: 'pending-comparison-log-provenance' };
      discoverTransfers(profile, state, owner, sidecar, discovery);

      for (const [id, capture] of Object.entries(state.pending)) pendingCapture(capture, owner, `${sidecar}, message ${id}`, profile, discovery);
    } catch (error) { discovery.warnings.push(`${sidecar}: pending comparison/transfer discovery unavailable: ${error.message}; coverage is incomplete`); }
  }
}

module.exports = { discoverPendingSnapshots, discoverPendingLogs };
