const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');

const resourceIdSchema = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }), cwd: Type.String(), archiveResourceId: Type.Optional(resourceIdSchema) });

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Union([Type.String(), Type.Null()]), area: Type.Union(['active', 'archived', 'unresolved'].map(value => Type.Literal(value))), relative: Type.Union([Type.String(), Type.Null()]), identity: Type.Union([Type.String(), Type.Null()]) });

const registrySchema = Type.Object({ session_id: Type.String({ minLength: 1 }), session_path: Type.Union([Type.String(), Type.Null()]), cwd: Type.Union([Type.String(), Type.Null()]) });

function canonical(file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file) throw new Error('Shared resource path has ambiguous ancestry: ' + file);
}

function validateHeader(header, file, expectedId) {
  if (!Check(headerSchema, header) || !path.isAbsolute(header.cwd)) throw new Error('Invalid shared resource owner header: ' + file);

  if (expectedId !== undefined && header.id !== expectedId) throw new Error('Registered shared resource owner identity changed: ' + file);
}

function headerAt(file, expectedId) {
  canonical(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });

    if (!before.isFile()) throw new Error('Shared resource owner is not a regular transcript: ' + file);
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);

    if (newline < 0) throw new Error('Shared resource owner header is incomplete: ' + file);
    const header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));

    validateHeader(header, file, expectedId);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const identity = String(before.dev) + ':' + before.ino;

    if (io.identity(file) !== identity || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Shared resource owner changed while reading: ' + file);

    return { header, identity };
  } finally { fs.closeSync(descriptor); }
}

function relativeCwd(binding, cwd) {
  const relative = path.relative(binding.path, path.resolve(cwd));

  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? null : relative;
}

function inferred(binding, cwd) {
  try { return relativeCwd(binding, fs.realpathSync(cwd)); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

function observe(file, area, binding, resourceId, found, expectedId) {
  const { header, identity } = headerAt(file, expectedId);
  const relative = header.archiveResourceId === resourceId ? relativeCwd(binding, header.cwd) : inferred(binding, header.cwd);

  if (header.archiveResourceId !== undefined && header.archiveResourceId !== resourceId) {
    if (inferred(binding, header.cwd) !== null) throw new Error('Directory has another durable shared resource identity; reconcile its journal before archiving');

    return;
  }

  if (relative === null && header.archiveResourceId !== resourceId) return;
  const owner = { sessionId: header.id, sessionPath: file, area: relative === null ? 'unresolved' : area, relative, identity };
  const prior = found.get(header.id);

  if (prior && prior.sessionPath !== file) throw new Error('Duplicate durable shared resource owner identity: ' + header.id);
  found.set(header.id, owner);
}

function registeredOwner(root, row, binding, resourceId, found) {
  if (!Check(registrySchema, row)) throw new Error('Invalid registry provenance prevents shared resource cleanup');

  if (found.has(row.session_id)) return;

  if (row.session_path && io.exists(row.session_path)) {
    const area = transcriptArea(root, row.session_path);

    observe(row.session_path, area, binding, resourceId, found, row.session_id);

    return;
  }

  if (row.cwd === null) {
    if (row.session_path) throw new Error('Registered shared resource transcript is unavailable: ' + row.session_path);

    return;
  }

  const relative = relativeCwd(binding, row.cwd);

  if (relative !== null) found.set(row.session_id, { sessionId: row.session_id, sessionPath: row.session_path, area: 'unresolved', relative, identity: null });
}

function transcriptArea(root, file) {
  if (io.inside(path.join(root, 'sessions'), file)) return 'active';

  return io.inside(path.join(root, 'archived'), file) ? 'archived' : 'unresolved';
}

function registered(root, binding, resourceId, found) {
  const database = require('./session-database.cjs').open(root);

  try {
    const query = `SELECT s.session_id, s.session_path, r.cwd FROM sessions s
      LEFT JOIN session_repositories r ON r.session_id=s.session_id
      WHERE NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id=lower(s.session_id))`;

    for (const row of database.prepare(query).all()) registeredOwner(root, row, binding, resourceId, found);
  } finally { database.close(); }
}

function pendingTranscripts(root, binding, resourceId, found) {
  const known = new Set(require('./session-broker/session-publication.cjs').temporaryPaths(root));

  for (const file of known) {
    if (io.exists(file)) observe(file, 'unresolved', binding, resourceId, found);
  }


}

function discover(root, binding, resourceId, recorded) {
  const found = new Map();

  registered(root, binding, resourceId, found);
  pendingTranscripts(root, binding, resourceId, found);

  for (const owner of recorded) {
    if (!found.has(owner.sessionId)) found.set(owner.sessionId, { ...owner, area: 'unresolved', identity: null });
  }

  return [...found.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

module.exports = { resourceIdSchema, ownerSchema, canonical, headerAt, discover };
