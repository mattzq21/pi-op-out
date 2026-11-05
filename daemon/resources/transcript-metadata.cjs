const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');
const fs = require('node:fs');
const path = require('node:path');

const invalidate = onMainThread('transcript-metadata.invalidate', (file) => {
  let root;

  try { root = database.storageRoot(file); }
  catch { return; }

  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    db.prepare('DELETE FROM session_file_metadata WHERE session_path=?').run(file);
    db.prepare('INSERT INTO session_file_writes SELECT session_id FROM sessions WHERE session_path=? ON CONFLICT DO NOTHING').run(file);
  });
});

const saveMetadata = onMainThread('transcript-metadata.saveMetadata', (root, file, modified, size) => {
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    db.prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
      ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size`)
      .run(modified, size, file);
    db.prepare("DELETE FROM session_file_writes WHERE session_id IN (SELECT session_id FROM sessions WHERE session_path=?)").run(file);
  });
});

function remember(file) {
  let root;

  try { root = database.storageRoot(file); }
  catch { return; }

  const metadata = savedFile(file);
  saveMetadata(root, file, String(metadata.mtimeNs), metadata.size);
}

function savedFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let metadata;

  try {
    metadata = fs.fstatSync(descriptor, { bigint: true });

    if (!metadata.isFile()) throw new Error('Saved transcript is not a regular file');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(parent); }
  finally { fs.closeSync(parent); }

  return metadata;
}

module.exports = { invalidate, remember };
