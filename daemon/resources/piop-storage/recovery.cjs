const { randomUUID } = require('node:crypto');
const { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeSync } = require('node:fs');
const { dirname, join } = require('node:path');

function transcript(id, cwd, name) {
  const timestamp = new Date().toISOString();
  const header = { type: 'session', version: 3, id, timestamp, cwd };
  const info = { type: 'session_info', id: randomUUID(), parentId: null, timestamp, name: 'Recovered queued input: ' + Array.from(Array.from(name).slice(0, 120).join('').trim()).slice(0, 120).join('') };
  return JSON.stringify(header) + '\n' + JSON.stringify(info) + '\n';
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createTranscript(path, id, cwd, name) {
  const temporary = join(dirname(path), '.queued-input-recovery-' + id);
  let created;
  try { created = installTranscript(path, temporary, transcript(id, cwd, name)); }
  catch (error) {
    try { removeTemporary(temporary); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Session recovery and cleanup failed'); }
    throw error;
  }
  removeTemporary(temporary);
  return created;
}

function removeTemporary(path) {
  let metadata;
  try { metadata = lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isFile()) throw new Error('Invalid queued-input recovery temporary file');
  unlinkSync(path);
  syncDirectory(dirname(path));
}

function installTranscript(path, temporary, body) {
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const bytes = Buffer.from(body);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("Recovered session write was incomplete");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { linkSync(temporary, path); } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  syncDirectory(dirname(path));
  return true;
}

module.exports = { createTranscript, removeTemporary };
