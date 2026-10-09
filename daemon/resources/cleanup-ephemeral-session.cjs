const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const files = require('./ephemeral-cleanup-files.cjs');
const records = require('./ephemeral-cleanup-records.cjs');
const checkpoints = require('./ephemeral-cleanup-checkpoints.cjs');
const pending = require('./ephemeral-cleanup-pending.cjs');

const uuidSchema = Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' });

const inspectSchema = Type.Object({ action: Type.Literal('inspect'), path: Type.String(), sessionId: Type.Union([uuidSchema, Type.Null()]) });

const cleanupSchema = Type.Object({ action: Type.Literal('cleanup'), path: Type.String(), sessionId: uuidSchema, identity: Type.String({ pattern: '^\\d+:\\d+$' }), token: uuidSchema, owner: Type.String({ minLength: 1 }), claims: Type.Array(Type.String({ minLength: 1 })) });

const entrySchema = Type.Object({ relative: Type.String(), identity: Type.String(), directory: Type.Boolean(), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) });

const itemSchema = Type.Object({ path: Type.String(), identity: Type.String(), directory: Type.Boolean(), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), entries: Type.Optional(Type.Array(entrySchema)) });

const repositorySchema = Type.Object({ root: Type.String(), identity: Type.String() });

const referenceSchema = Type.Object({ root: Type.String(), identity: Type.String(), ref: Type.String(), oid: Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }) });

const manifestSchema = Type.Object({ version: Type.Literal(1), token: uuidSchema, owner: Type.String(), sessionId: uuidSchema, path: Type.String(), identity: Type.String(), phase: Type.Union([Type.Literal('waiting'), Type.Literal('prepared'), Type.Literal('complete')]), files: Type.Array(itemSchema), repositories: Type.Array(repositorySchema), references: Type.Array(referenceSchema), pendingComparisons: Type.Array(Type.Unknown()) });

function profileRoot() {
  const root = path.resolve(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

  files.directory(root);

  return fs.realpathSync(root);
}

function claimKey(id) { return createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 40); }

function workerPaths(request, profile) {
  const directory = path.join(profile, 'session-claims');

  files.directory(directory);
  const claims = [request.sessionId, ...request.claims].map(id => path.join(directory, `id-${claimKey(id)}.lock`));

  return [...new Set(claims)].sort();
}

function storagePaths(request, profile) { return [path.join(profile, 'session-transactions.lock'), request.path.replace(/\.jsonl$/, '.diffs.json.lock')].sort(); }

function inheritedWorkers(request, profile) {
  const descriptors = process.env.PIOP_EPHEMERAL_WORKER_FDS;

  if (descriptors === undefined) return workerPaths(request, profile).map((_, index) => index + 3);

  if (!Check(Type.String({ pattern: '^\\d+(?:,\\d+)*$' }), descriptors)) throw new Error('Cleanup worker lock inheritance is unavailable; retained');

  return descriptors.split(',').map(Number);
}

function lock(request, profile, storage) {
  const flag = storage ? '--storage-locked' : '--workers-locked';

  if (process.argv.includes(flag)) return true;
  const inherited = storage ? inheritedWorkers(request, profile) : [];
  const paths = storage ? storagePaths(request, profile) : workerPaths(request, profile);
  const descriptors = [];

  try {
    for (const file of paths) descriptors.push(fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600));
    const script = descriptors.map((_, index) => `flock --nonblock ${index + inherited.length + 3} || exit $?;`).join(' ') + ' exec "$@"';
    const flags = storage ? [flag, '--permitted'] : [flag];

    const child = spawnSync('sh', ['-c', script, 'piop-ephemeral-cleanup', process.execPath, ...process.execArgv, '--', ...process.argv.slice(1), ...flags], { stdio: ['inherit', 'inherit', 'inherit', ...inherited, ...descriptors], timeout: 120000 });

    if (child.error) throw child.error;

    if (child.status !== 0) throw new Error('Ephemeral worker or storage claim is busy, unavailable, or cleanup failed; retained for retry');

    return false;
  } finally { for (const descriptor of descriptors) fs.closeSync(descriptor); }
}

function transcriptPresent(request, profile) {
  if (files.exists(request.path)) {
    const inspected = checkpoints.inspect(request.path, request.sessionId);

    if (inspected.identity !== request.identity) throw new Error('Ephemeral transcript identity changed; cleanup retained');

    return true;
  }

  const manifest = records.read(profile, request.token);

  validateManifest(manifest, request);

  if (manifest.phase === 'waiting') throw new Error('Ephemeral transcript is unavailable before cleanup preparation; retained');

  return false;
}

async function permit(request, profile) {
  if (process.argv.includes('--permitted')) return;
  const present = transcriptPresent(request, profile);

  process.stdout.write(`${JSON.stringify({ inactive: true, transcriptPresent: present, recoverPending: recoveryRequired(request, profile, present) })}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line !== 'cleanup-authorized') throw new Error('Cleanup eligibility was not confirmed; retained');

      return;
    }

    throw new Error('Cleanup owner disconnected before confirming eligibility; retained');
  } finally { lines.close(); process.stdin.pause(); }
}

function recoveryRequired(request, profile, present) {
  if (!present) return false;
  const manifest = records.read(profile, request.token);

  if (manifest === undefined) return true;

  validateManifest(manifest, request);

  if (manifest.phase === 'complete') throw new Error('Ephemeral transcript reappeared after cleanup; retained');

  return manifest.phase === 'waiting' || pending.inspect(request.path, request.sessionId, profile).length > 0;
}

function artifacts(file) { return [file.replace(/\.jsonl$/, '.snapshots'), file.replace(/\.jsonl$/, '.diffs.json'), `${file}.loop-detection.json`, file]; }

function validateManifest(manifest, request) {
  if (!Check(manifestSchema, manifest)) throw new Error('Invalid ephemeral cleanup manifest; retained');

  for (const key of ['token', 'owner', 'sessionId', 'path', 'identity']) {
    if (manifest[key] !== request[key]) throw new Error('Ephemeral cleanup ownership changed; retained');
  }

  for (const item of manifest.files) {
    if (!artifacts(request.path).includes(item.path)) throw new Error('Cleanup manifest contains an unowned artifact; retained');
  }

  const prefix = `refs/pi-session-snapshots/chats/${request.sessionId}/`;
  const legacy = `refs/pi-session-snapshots/${request.sessionId}`;

  for (const item of manifest.references) {
    if (!item.ref.startsWith(prefix) && item.ref !== legacy) throw new Error('Cleanup manifest contains an unowned checkpoint; retained');
  }
}

async function prepare(request, profile) {
  const inspected = checkpoints.inspect(request.path, request.sessionId);

  if (inspected.identity !== request.identity) throw new Error('Ephemeral transcript inode changed; retained');
  const comparisons = pending.inspect(request.path, request.sessionId, profile);

  const manifest = { version: 1, token: request.token, owner: request.owner, sessionId: request.sessionId, path: request.path, identity: request.identity, phase: 'waiting', files: [], repositories: [], references: [], pendingComparisons: comparisons };

  records.write(profile, manifest);

  if (comparisons.length) throw new Error(`Ephemeral cleanup deferred: ${comparisons.length} pending comparisons/transfers retain source logs and comparison/transfer staging`);
  const captured = await checkpoints.capture(request.path, inspected.header);
  manifest.repositories = captured.repositories;
  manifest.references = captured.references;

  for (const file of artifacts(request.path)) if (files.exists(file)) manifest.files.push(files.describe(file));
  const after = checkpoints.inspect(request.path, request.sessionId);

  if (after.identity !== request.identity) throw new Error('Ephemeral transcript changed during cleanup preparation; retained');
  manifest.phase = 'prepared';
  records.write(profile, manifest);

  return manifest;
}

function verify(manifest, request, profile) {
  if (files.exists(request.path)) {
    const inspected = checkpoints.inspect(request.path, request.sessionId);

    if (inspected.identity !== request.identity) throw new Error('Ephemeral transcript identity changed; retained');
  }

  if (pending.inspect(request.path, request.sessionId, profile).length) throw new Error('Pending comparisons or transfers appeared; cleanup retained');

  for (const file of artifacts(request.path)) {
    if (files.exists(file) && !manifest.files.some(item => item.path === file)) throw new Error(`New ephemeral artifact appeared; retained: ${file}`);
  }

  for (const item of manifest.files) files.verify(item);
  checkpoints.verify(manifest);
}

async function cleanup(request, profile) {
  let manifest = records.read(profile, request.token);

  if (manifest !== undefined) {
    validateManifest(manifest, request);

    if (manifest.phase === 'complete') {
      if (artifacts(request.path).some(file => files.exists(file))) throw new Error('Ephemeral artifacts reappeared after cleanup; retained');

      if (pending.inspect(request.path, request.sessionId, profile).length) throw new Error('Pending comparisons or transfers appeared after cleanup; retained');
      records.write(profile, manifest);

      return { complete: true };
    }
  }

  if (!manifest || manifest.phase === 'waiting') manifest = await prepare(request, profile);
  verify(manifest, request, profile);

  for (const item of manifest.references) checkpoints.remove(item);

  for (const item of manifest.files) files.remove(item);
  manifest.phase = 'complete';
  records.write(profile, manifest);

  return { complete: true };
}

async function main() {
  const request = JSON.parse(process.argv[1]);

  if (Check(inspectSchema, request)) {
    const inspected = checkpoints.inspect(request.path, request.sessionId);
    process.stdout.write(JSON.stringify({ sessionId: inspected.sessionId, identity: inspected.identity }));

    return;
  }

  if (!Check(cleanupSchema, request)) throw new Error('Cleanup requires durable owner, session and file identity');
  const profile = profileRoot();

  if (!lock(request, profile, false)) return;
  await permit(request, profile);

  if (lock(request, profile, true)) process.stdout.write(JSON.stringify(await cleanup(request, profile)));
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
