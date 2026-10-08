const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { addRoot, absolute } = require('./storage-inventory-roots.cjs');
const { readStore } = require('./session-broker/git-diff-store.cjs');

const uuid = Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' });

const locationSchema = Type.Union([Type.Object({ kind: Type.Literal('local'), path: Type.String() }), Type.Object({ kind: Type.Literal('remote'), path: Type.String(), host: Type.Object({ target: Type.String() }) })]);

const ownerSchema = Type.Object({ version: Type.Literal(1), token: uuid, owner: Type.String({ minLength: 1 }), sessionId: uuid, identity: Type.String({ pattern: '^\\d+:\\d+$' }), location: locationSchema, queued: Type.Boolean(), claims: Type.Array(Type.String()), lastError: Type.Optional(Type.Union([Type.String(), Type.Null()])) });

const tokenSchema = Type.Object({ root: Type.String(), repository_root: Type.String(), tree: Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }) });

const captureSchema = Type.Object({ baseline: Type.String(), current: Type.String() });

const pointerSchema = Type.Object({ sessionId: Type.String(), id: Type.String(), capture: captureSchema });

const manifestSchema = Type.Object({ phase: Type.Union(['waiting', 'prepared', 'complete'].map(value => Type.Literal(value))), sessionId: uuid, path: Type.String() });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: uuid });

async function entries(directory, warnings) {
  try {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Storage root is not a regular directory');

    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push(`${directory}: cleanup/pending ownership discovery unavailable: ${error.message}`);

    return [];
  }
}

async function json(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try { return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}

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

async function ownerRecord(file, discovery) {
  const root = addRoot(discovery.cleanup, file, 'Ephemeral cleanup ownership record; validation pending', 'owned');
  root.state = 'unresolved';

  try {
    const record = await json(file);

    if (!Check(ownerSchema, record) || ownerFilename(record) !== path.basename(file) || !absolute(record.location.path) || !record.location.path.endsWith('.jsonl')) throw new Error('Invalid ephemeral ownership identity or location');
    root.state = record.queued ? 'queued-eligible' : 'active-record';
    root.provenance = [`Durable owner: ${record.owner}; token: ${record.token}; ${record.claims.length} recorded claim identities, not live owners`];
    root.owners = [{ sessionId: record.sessionId, sessionPath: record.location.path, kind: record.queued ? 'cleanup-queue-provenance' : 'ephemeral-owner-provenance' }];

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
    const record = await json(file);

    if (!Check(pointerSchema, record)) throw new Error('Invalid global pending comparison pointer');
    const session = [...discovery.ephemeralRecords.values()].find(owner => owner.sessionId === record.sessionId);
    const owner = { sessionId: record.sessionId, sessionPath: session?.location.path, kind: 'pending-comparison-pointer-provenance' };
    pendingCapture(record.capture, owner, file, profile, discovery);
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${file}: global pending comparison ownership unavailable: ${error.message}; snapshots retained`);
  }
}

async function manifests(root, discovery) {
  for (const entry of await entries(path.join(root, 'manifests'), discovery.warnings)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(root, 'manifests', entry.name);
    const record = addRoot(discovery.cleanup, file, 'Ephemeral cleanup manifest; retained for identity verification and crash replay', 'owned');

    try {
      const manifest = await json(file);

      if (!Check(manifestSchema, manifest)) throw new Error('Invalid cleanup manifest ownership or phase');
      record.state = manifest.phase;
      record.owners = [{ sessionId: manifest.sessionId, sessionPath: manifest.path, kind: 'cleanup-manifest-provenance' }];
    } catch (error) { discovery.warnings.push(`${file}: cleanup manifest unavailable: ${error.message}`); }
  }

}

async function discoverEphemeral(profile, discovery) {
  const root = path.join(profile, 'ephemeral-cleanup');

  for (const entry of await entries(path.join(root, 'owners'), discovery.warnings)) {
    if (entry.isFile() && entry.name.endsWith('.json')) await ownerRecord(path.join(root, 'owners', entry.name), discovery);
  }

  await manifests(root, discovery);

  for (const entry of await entries(path.join(profile, 'git-snapshots'), discovery.warnings)) {
    if (entry.isDirectory() && entry.name.startsWith('pi-desktop-diff-')) await pointer(path.join(profile, 'git-snapshots', entry.name), profile, discovery);
  }
}

function discoverPendingLogs(profile, discovery) {
  for (const [file, header] of discovery.headers) {
    const sidecar = file.replace(/\.jsonl$/, '.diffs.json');

    try {
      const state = readStore(sidecar, false);
      const owner = { sessionId: header.id, sessionPath: file, kind: 'pending-comparison-log-provenance' };

      for (const [id, capture] of Object.entries(state.pending)) pendingCapture(capture, owner, `${sidecar}, message ${id}`, profile, discovery);
    } catch (error) { discovery.warnings.push(`${sidecar}: pending comparison discovery unavailable: ${error.message}; coverage is incomplete`); }
  }
}

module.exports = { discoverEphemeral, discoverPendingLogs };
