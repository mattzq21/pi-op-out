const fs = require('node:fs');
const path = require('node:path');
const io = require('./session-transactions.cjs');
const { validSessionHeader } = require('./session-header.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');

function readSession(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

  if (!validSessionHeader(entries[0])) throw new Error(`Invalid session: ${file}`);

  return entries;
}

function destinationFree(destination) {
  for (const target of [destination, destination.replace(/\.jsonl$/, '.snapshots')]) {
    if (io.exists(target)) throw new Error(`Archive destination already exists: ${target}`);
  }
}

function planTargets(root, files) {
  const sessions = fs.realpathSync(path.join(root, 'sessions'));
  const archived = path.join(root, 'archived');
  const selected = new Set();

  return files.map(file => {
    if (!io.inside(sessions, file) || !io.inside(root, file) || file === sessions || !file.endsWith('.jsonl') || !fs.lstatSync(file).isFile()) throw new Error('Only active piop sessions can be archived');
    const entries = readSession(file);
    const destination = path.join(archived, canonicalTranscriptBasename(entries[0]));

    if (selected.has(destination)) throw new Error(`Duplicate archive transcript mapping: ${destination}`);
    selected.add(destination);
    destinationFree(destination);

    return { path: file, sessionId: entries[0].id, destination, entries, mode: fs.statSync(file).mode & 0o777 };
  });
}

module.exports = { planTargets };
