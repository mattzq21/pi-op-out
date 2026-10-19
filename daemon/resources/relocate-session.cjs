const fs = require('node:fs');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const { acquireReferencePublicationLock } = require('./piop-storage/reference-publication-lock.cjs');

/** Points the session header at another working directory. */
function relocateSession(profile, sessionPath, requestedReplacement) {
  const release = acquireReferencePublicationLock(profile, true);

  try {
    const replacement = fs.realpathSync(requestedReplacement);

    if (!fs.statSync(replacement).isDirectory()) throw new Error('Project directory does not exist');
    rewriteHeader(sessionPath, replacement);
  } finally { release(); }
}

function rewriteHeader(sessionPath, replacement) {
  const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
  const header = JSON.parse(lines[0]);

  if (header.type !== 'session') throw new Error('Invalid session header');
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

/** Accepts only a session file inside the sessions directory of request.profile and an existing project directory. */
function checkedRelocation(request) {
  if (typeof request.profile !== 'string' || typeof request.sessionPath !== 'string' || typeof request.cwd !== 'string') throw new Error('Invalid relocation request');
  let root, source;

  try { root = fs.realpathSync(join(request.profile, 'sessions')); } catch (error) { throw new Error(`Could not locate piop sessions: ${error.message}`); }

  try { source = fs.realpathSync(request.sessionPath); } catch (error) { throw new Error(`Could not locate session file: ${error.message}`); }

  if (!source.startsWith(root + '/') || !source.endsWith('.jsonl') || !fs.statSync(source).isFile()) throw new Error('Refusing to relocate a non-desktop session file');
  const replacement = request.cwd.trim();
  let directory = false;

  try { directory = fs.statSync(replacement).isDirectory(); } catch {}

  if (!directory) throw new Error(`Project directory does not exist: ${replacement}`);
  relocateSession(request.profile, source, replacement);

  return null;
}

module.exports = { relocateSession, checkedRelocation };
