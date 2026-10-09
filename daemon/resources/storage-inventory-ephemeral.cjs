const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { addRoot, absolute } = require('./storage-inventory-roots.cjs');
const { readStore } = require('./session-broker/git-diff-store.cjs');
const { discoverTransfers } = require('./storage-inventory-transfers.cjs');

const uuid = Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' });

const locationSchema = Type.Union([Type.Object({ kind: Type.Literal('local'), path: Type.String() }), Type.Object({ kind: Type.Literal('remote'), path: Type.String(), host: Type.Object({ target: Type.String() }) })]);

const ownerSchema = Type.Object({ version: Type.Literal(1), token: uuid, owner: Type.String({ minLength: 1 }), sessionId: uuid, identity: Type.String({ pattern: '^\\d+:\\d+$' }), location: locationSchema, queued: Type.Boolean(), claims: Type.Array(Type.String()), lastError: Type.Optional(Type.Union([Type.String(), Type.Null()])) });

const tokenSchema = Type.Object({ root: Type.String(), repository_root: Type.String(), tree: Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }) });

const captureSchema = Type.Object({ baseline: Type.String(), current: Type.String() });

const pointerSchema = Type.Object({ sessionId: Type.String(), id: Type.String(), capture: captureSchema });

const manifestSchema = Type.Object({ phase: Type.Union(['waiting', 'prepared', 'complete'].map(value => Type.Literal(value))), sessionId: uuid, path: Type.String() });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: uuid });

function ownerFilename(record) {
  const machine = record.location.kind === 'local' ? 'local' : record.location.host.target;

  return `${createHash('sha256').update(`${machine}\n${record.location.path}`).digest('hex').slice(0, 40)}.json`;
}

function artifacts(file) { return [file, file.replace(/\.jsonl$/, '.diffs.json'), file.replace(/\.jsonl$/, '.snapshots'), `${file}.loop-detection.json`, file.replace(/\.jsonl$/, '.diffs.json.lock')]; }

async function ownedTranscript(record) {
  const file = record.location.path;
  const metadata = await fs.lstat(file, { bigint: true });

  if (!metadata.isFile() || metadata.isSymbolicLink() || `${metadata.dev}:${metadata.ino}` !== record.identity) throw new Error('Transcript inode no longer matches the durable ownership record');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);

    if (newline < 0) throw new Error('Transcript header is incomplete');
    const header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));

    if (!Check(headerSchema, header) || header.id !== record.sessionId) throw new Error('Transcript identity no longer matches the ownership record');
  } finally { await handle.close(); }
}

async function ownedArtifacts(record, file, discovery) {
  const owners = [{ sessionId: record.sessionId, sessionPath: record.location.path, kind: record.queued ? 'cleanup-queue-provenance' : 'active-ephemeral-record-provenance' }];
  let ownership = 'owned';

  try { await ownedTranscript(record); discovery.ephemeralRecords.set(record.location.path, record); discovery.sessionPaths.add(record.location.path); }
  catch (error) { ownership = 'unattributed'; discovery.warnings.push(`${file}: ephemeral transcript ownership unresolved: ${error.message}; retained`); }

  for (const artifact of artifacts(record.location.path)) {
    try { await fs.lstat(artifact); }
    catch (error) { if (error.code === 'ENOENT') continue; discovery.warnings.push(`${artifact}: owned ephemeral artifact unavailable: ${error.message}`); }

    const root = addRoot(discovery.ephemeral, artifact, `Durable ephemeral owner record: ${file}; owner key: ${record.owner}; claims are provenance, not live counts`, ownership, owners);
    root.ownership = ownership;
    root.state = record.queued ? 'queued-for-cleanup' : 'active-owner-record';
  }
}

async function ownerRecord(file, row, discovery) {

  try {
    const record = JSON.parse(row.record_json);

    if (!Check(ownerSchema, record) || ownerFilename(record) !== `${row.owner_key}.json` || !absolute(record.location.path) || !record.location.path.endsWith('.jsonl')) throw new Error('Invalid ephemeral ownership identity or location');
    const owners = [{ sessionId: record.sessionId, sessionPath: record.location.path, kind: record.queued ? 'cleanup-queue-provenance' : 'ephemeral-owner-provenance' }];
    const root = addRoot(discovery.cleanup, file, `Cleanup owner ${row.owner_key}: ${record.queued ? 'queued' : 'active'}; token: ${record.token}`, 'shared', owners);
    root.state = 'stored-cleanup-records';

    if (record.lastError) discovery.warnings.push(`${file}: retained ephemeral cleanup: ${record.lastError}`);

    if (record.location.kind === 'remote') {
      discovery.warnings.push(`${file}: remote ephemeral artifacts on ${record.location.host.target} are outside this host scan; owner metadata is included, target bytes/liveness are unavailable here`);

      return;
    }

    await ownedArtifacts(record, file, discovery);
  } catch (error) { discovery.warnings.push(`${file}: cleanup owner provenance unavailable: ${error.message}; record retained`); }
}

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
    const session = [...discovery.ephemeralRecords.values()].find(owner => owner.sessionId === record.sessionId);
    const owner = { sessionId: record.sessionId, sessionPath: session?.location.path, kind: 'pending-comparison-pointer-provenance' };
    pendingCapture(record.capture, owner, file, profile, discovery);
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${file}: global pending comparison ownership unavailable: ${error.message}; snapshots retained`);
  }
}

async function manifests(root, discovery) {
  const profile = path.dirname(root);
  const file = path.join(profile, 'sessions.sqlite');

  const records = require('./ephemeral-cleanup-records.cjs').list(profile);
  discovery.cleanupRecordCount += records.length;

  for (const row of records) {
    try {
      const manifest = JSON.parse(row.record_json);

      if (!Check(manifestSchema, manifest)) throw new Error('Invalid cleanup manifest ownership or phase');
      const owners = [{ sessionId: manifest.sessionId, sessionPath: manifest.path, kind: 'cleanup-manifest-provenance' }];
      const record = addRoot(discovery.cleanup, file, `Cleanup record ${row.token}: ${manifest.phase}`, 'shared', owners);
      record.state = 'stored-cleanup-records';
    } catch (error) { discovery.warnings.push(`${file}, cleanup record ${row.token}: ${error.message}`); }
  }
}

async function discoverEphemeral(profile, discovery) {
  const root = path.join(profile, 'ephemeral-cleanup');

  const owners = require('./session-database.cjs').ephemeralOwners(profile);
  discovery.cleanupRecordCount += owners.length;

  for (const row of owners) {
    await ownerRecord(path.join(profile, 'sessions.sqlite'), row, discovery);
  }

  await externalSessions(profile, discovery);
  await manifests(root, discovery);

  for (const row of require('./session-database.cjs').snapshotDirectories(profile)) {
    if (path.dirname(row.directory) === path.join(profile, 'git-snapshots') && path.basename(row.directory).startsWith('pi-desktop-diff-')) await pointer(row.directory, profile, discovery);
  }
}

async function externalSessions(profile, discovery) {
  const records = require('./external-transcripts.cjs');

  for (const row of records.list(profile)) {
    try {
      const file = records.transcript(row);

      if (!/^pi-desktop-btw-[a-f0-9-]{36}\.jsonl$/.test(path.basename(file)) || discovery.ephemeralRecords.has(file)) continue;
      await externalArtifacts(file, discovery);
    } catch (error) { discovery.warnings.push(`External transcript ${row.record_id}: storage unavailable: ${error.message}`); }
  }
}

async function externalArtifacts(file, discovery) {
  for (const artifact of artifacts(file)) {
    let metadata;

    try { metadata = await fs.lstat(artifact); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    addRoot(discovery.ephemeral, artifact, 'Saved external transcript path; runtime liveness unknown', 'unattributed');

    if (artifact !== file) continue;

    if (!metadata.isFile() || await fs.realpath(file) !== file) throw new Error('External transcript is not a regular canonical file');
    discovery.sessionPaths.add(file);
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

module.exports = { discoverEphemeral, discoverPendingLogs };
