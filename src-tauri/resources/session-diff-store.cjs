const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const maximumRecordBytes = 16 * 1024 * 1024;

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function publish(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    sync(temporary);
    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function patchValue(value) {
  if (value === String(value)) return value;

  if (value.patch !== String(value.patch)) throw new Error('Invalid saved diff');

  return value.toolPaths?.length ? { patch: value.patch, toolPaths: value.toolPaths } : { patch: value.patch };
}

function diffDirectory(session) {
  return path.join(session.replace(/\.jsonl$/, '.snapshots'), 'diffs');
}

function recordFile(directory, messageId) {
  return path.join(directory, `${createHash('sha256').update(messageId).digest('hex')}.json`);
}

function regularJson(file, bounded = false) {
  const stat = fs.lstatSync(file);

  if (!stat.isFile()) throw new Error('Diff storage must contain regular files');

  if (bounded && stat.size > maximumRecordBytes * 2) throw new Error('Saved diff record exceeds its size limit');

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function legacyDiffs(session) {
  const sidecar = session.replace(/\.jsonl$/, '.diffs.json');

  return fs.existsSync(sidecar) ? regularJson(sidecar) : {};
}

function loadDiffs(session) {
  const saved = legacyDiffs(session);
  const directory = diffDirectory(session);

  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Invalid diff storage directory');

    for (const entry of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const record = regularJson(path.join(directory, entry), true);

      if (record.messageId !== String(record.messageId) || recordFile(directory, record.messageId) !== path.join(directory, entry)) throw new Error('Saved diff identity changed');
      Object.defineProperty(saved, record.messageId, { value: record.snapshot, enumerable: true, configurable: true, writable: true });
    }
  }

  return Object.fromEntries(Object.entries(saved).map(([id, value]) => [id, patchValue(value)]));
}

function writeRecord(directory, messageId, value) {
  const record = { messageId, snapshot: patchValue(value) };

  if (Buffer.byteLength(JSON.stringify(record.snapshot)) > maximumRecordBytes) throw new Error('Diff record exceeds the 16 MiB limit');

  if (Buffer.byteLength(JSON.stringify(record)) > maximumRecordBytes * 2) throw new Error('Diff record identifier exceeds its size limit');
  publish(recordFile(directory, messageId), record);
}

function saveDiffs(session, incoming) {
  const directory = diffDirectory(session);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (fs.realpathSync(directory) !== directory) throw new Error('Diff storage cannot be a symlink');
  sync(path.dirname(directory));
  sync(path.dirname(path.dirname(directory)));

  for (const entry of fs.readdirSync(directory)) {
    if (/^[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/.test(entry)) fs.rmSync(path.join(directory, entry));
  }

  const legacy = legacyDiffs(session);

  for (const [messageId, value] of Object.entries(legacy)) {
    if (!fs.existsSync(recordFile(directory, messageId))) writeRecord(directory, messageId, value);
  }

  if (Object.keys(legacy).length) publish(session.replace(/\.jsonl$/, '.diffs.json'), {});

  for (const [messageId, value] of Object.entries(incoming)) writeRecord(directory, messageId, value);
}

function runDiffStore(action, session) {
  if (action === 'load') return process.stdout.write(JSON.stringify(loadDiffs(session)));

  if (action !== 'save') throw new Error('Invalid diff storage operation');
  saveDiffs(session, JSON.parse(fs.readFileSync(0, 'utf8')));
}

module.exports = { loadDiffs, saveDiffs, runDiffStore };
