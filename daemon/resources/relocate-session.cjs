const fs = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const io = require('./session-transactions.cjs');
const { acquireReferencePublicationLock } = require('./storage-lock.cjs');

const { randomUUID } = require('node:crypto');

const release = acquireReferencePublicationLock(join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'), true);

process.on('exit', release);

const [sessionPath, requestedReplacement] = process.argv.slice(1);

const replacement = fs.realpathSync(requestedReplacement);

if (!fs.statSync(replacement).isDirectory()) throw new Error('Project directory does not exist');

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
