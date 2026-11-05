const fs = require('node:fs');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const { acquireReferencePublicationLock } = require('./piop-storage/reference-publication-lock.cjs');

function relocateSession(profile, sessionPath, requestedReplacement, from) {
  const release = acquireReferencePublicationLock(profile, true);

  try {
    const replacement = fs.realpathSync(requestedReplacement);

    if (!fs.statSync(replacement).isDirectory()) throw new Error('Project directory does not exist');
    rewriteHeader(sessionPath, replacement, from);
  } finally { release(); }
}

// Writes the transcript again with cwd replacement, at the same path. With from, only a transcript that works in from.
function rewriteHeader(sessionPath, replacement, from) {
  const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
  const header = JSON.parse(lines[0]);

  if (header.type !== 'session') throw new Error('Invalid session header');

  if (from !== undefined && header.cwd !== from) return;
  header.cwd = replacement;
  lines[0] = JSON.stringify(header);
  const temporary = `${sessionPath}.${randomUUID()}.tmp`;
  let file;

  try {
    const mode = fs.statSync(sessionPath).mode & 0o777;
    file = fs.openSync(temporary, 'wx', mode);
    fs.fchmodSync(file, mode);
    fs.writeFileSync(file, lines.join('\n'));
    fs.fsyncSync(file);
    fs.closeSync(file); file = undefined;
    require('./transcript-metadata.cjs').invalidate(sessionPath);
    fs.renameSync(temporary, sessionPath);
    io.sync(dirname(sessionPath));
    require('./transcript-metadata.cjs').remember(sessionPath);
  } finally {
    if (file !== undefined) fs.closeSync(file);
    fs.rmSync(temporary, { force: true });
  }
}

function checkedRelocation(request) {
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string' || typeof request.cwd !== 'string' || (request.from !== undefined && typeof request.from !== 'string')) throw new Error('Invalid relocation request');
  let root, source;

  try { root = fs.realpathSync(join(request.profile, 'sessions')); } catch (error) { throw new Error(`Could not locate piop sessions: ${error.message}`); }

  try { source = fs.realpathSync(request.sessionPath); } catch (error) { throw new Error(`Could not locate session file: ${error.message}`); }

  if (!source.startsWith(root + '/') || !source.endsWith('.jsonl') || !fs.statSync(source).isFile()) throw new Error('Refusing to relocate a non-desktop session file');
  const replacement = request.cwd.trim();
  let directory = false;

  try { directory = fs.statSync(replacement).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Error(`Could not check project directory ${replacement}: ${error.message}`); }

  if (!directory) throw new Error(`Project directory does not exist: ${replacement}`);
  relocateSession(request.profile, source, replacement, request.from);

  return null;
}

module.exports = { relocateSession, checkedRelocation };
