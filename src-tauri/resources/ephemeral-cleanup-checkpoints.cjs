const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { execFileSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const files = require('./ephemeral-cleanup-files.cjs');

const oidSchema = Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' }), cwd: Type.Optional(Type.String()), checkpointRepositoryRoot: Type.Optional(Type.String()) });

const snapshotSchema = Type.Object({ ref: Type.String(), commit: oidSchema, repositoryRoot: Type.Optional(Type.String()) });

const promptSchema = Type.Object({ key: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }), commit: oidSchema, repositoryRoot: Type.Optional(Type.String()) });

function git(root, args, input) {
  return execFileSync('git', ['--git-dir', root, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', ...args], { encoding: 'utf8', input, timeout: 10000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function prefixes(id) { return [`refs/pi-session-snapshots/chats/${id}/`, `refs/pi-session-snapshots/${id}`]; }

function owned(ref, id) {
  const [prefix, legacy] = prefixes(id);

  return ref.startsWith(prefix) || ref === legacy;
}

function regularTranscript(file) {
  const metadata = fs.lstatSync(file);

  if (!metadata.isFile() || metadata.isSymbolicLink() || !path.isAbsolute(file) || path.normalize(file) !== file || !file.endsWith('.jsonl')) throw new Error('Ephemeral transcript must be an exact regular file path');
}

function inspect(file, expectedId) {
  regularTranscript(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);

    if (newline < 0) throw new Error('Ephemeral session header is incomplete');
    const header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));

    if (!Check(headerSchema, header)) throw new Error('Invalid ephemeral session identity');

    if (expectedId && header.id !== expectedId) throw new Error('Ephemeral session identity changed; retained');

    return { sessionId: header.id, identity: files.identity(file), header };
  } finally { fs.closeSync(descriptor); }
}

function entryRepository(entry, header) { return entry?.data?.repositoryRoot ?? header.checkpointRepositoryRoot ?? header.cwd; }

function observation(entry, header, roots, expected) {
  const root = entryRepository(entry, header);

  if (Check(Type.String(), root)) roots.add(root);

  if (entry?.type !== 'custom') return;

  if (entry.customType === 'pi-project-files-watch-snapshot' && Check(snapshotSchema, entry.data) && owned(entry.data.ref, header.id)) expected.set(`${root}\n${entry.data.ref}`, entry.data.commit);

  if (entry.customType === 'pi-project-prompt-checkpoint' && Check(promptSchema, entry.data)) expected.set(`${root}\n${prefixes(header.id)[0]}prompts/${entry.data.key}`, entry.data.commit);
}

async function transcript(file, header) {
  const roots = new Set();
  const expected = new Map();

  for (const root of [header.cwd, header.checkpointRepositoryRoot]) if (Check(Type.String(), root)) roots.add(root);
  const input = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line.trim()) observation(JSON.parse(line), header, roots, expected);
    }
  } finally { lines.close(); input.destroy(); }

  return { roots, expected };
}

function commonRoot(root) {
  if (!path.isAbsolute(root) || !files.exists(root)) throw new Error(`Checkpoint root unavailable; cleanup retained: ${root}`);

  try {
    const common = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    return fs.realpathSync(common);
  } catch (error) {
    if (String(error.stderr).includes('not a git repository')) return undefined;
    throw error;
  }
}

function listed(root, id) {
  const result = [];

  for (const line of git(root, ['for-each-ref', '--format=%(refname) %(objectname)', ...prefixes(id)]).split('\n')) {
    const [ref, oid] = line.split(' ');

    if (owned(ref, id)) result.push({ ref, oid });
  }

  return result;
}

async function capture(file, header) {
  const { roots, expected } = await transcript(file, header);
  const repositories = new Map();

  for (const root of roots) {
    const common = commonRoot(root);

    if (!common) continue;

    if (!repositories.has(common)) repositories.set(common, { root: common, identity: files.identity(common), expected: new Map() });
    const repository = repositories.get(common);

    for (const [key, oid] of expected) {
      if (key.startsWith(`${root}\n`)) repository.expected.set(key.slice(root.length + 1), oid);
    }
  }

  const references = [];

  for (const repository of repositories.values()) {
    for (const { ref, oid } of listed(repository.root, header.id)) {
      if (repository.expected.get(ref) !== oid) throw new Error(`Unattributed or changed checkpoint retained: ${ref}`);
      references.push({ root: repository.root, identity: repository.identity, ref, oid });
    }
  }

  return { references, repositories: [...repositories.values()].map(repository => ({ root: repository.root, identity: repository.identity })) };
}

function current(item) {
  if (files.identity(item.root) !== item.identity) throw new Error(`Checkpoint repository identity changed: ${item.root}`);

  try { return git(item.root, ['show-ref', '--verify', '--hash', item.ref]); }
  catch (error) { if (error.status === 1) return undefined; throw error; }
}

function verify(manifest) {
  for (const item of manifest.references) {
    const actual = current(item);

    if (actual && actual !== item.oid) throw new Error(`Checkpoint changed; cleanup retained: ${item.ref}`);
  }

  for (const repository of manifest.repositories) {
    if (files.identity(repository.root) !== repository.identity) throw new Error(`Checkpoint repository changed; cleanup retained: ${repository.root}`);

    for (const { ref, oid } of listed(repository.root, manifest.sessionId)) {
      if (!manifest.references.some(item => item.root === repository.root && item.ref === ref && item.oid === oid)) throw new Error(`New checkpoint appeared; cleanup retained: ${ref}`);
    }
  }
}

function remove(item) {
  const actual = current(item);

  if (!actual) return;

  if (actual !== item.oid) throw new Error(`Checkpoint changed; retained: ${item.ref}`);
  git(item.root, ['update-ref', '-d', item.ref, item.oid]);
}

module.exports = { inspect, capture, verify, remove };
