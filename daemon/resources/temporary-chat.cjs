const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function directoryExists(directory) {
  try {
    const info = fs.lstatSync(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary chat path must be a directory, not a link');

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sync(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function create(db, root, directory, id) {
  const reserve = db.prepare('INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING');
  reserve.run(id, directory);
  db.exec('BEGIN IMMEDIATE');
  reserve.run(id, directory);
  const saved = db.prepare('SELECT original_path FROM temporary_chat_allocations WHERE session_id=?').get(id);

  if (saved.original_path !== directory) throw new Error('Temporary chat directory does not match its saved record');

  if (!directoryExists(path.join(root, 'tmp'))) fs.mkdirSync(path.join(root, 'tmp'));

  if (!directoryExists(directory)) fs.mkdirSync(directory);
  sync(path.join(root, 'tmp'));
  sync(root);
  process.stdout.write(directory);
}

function remove(db, directory, id) {
  db.exec('BEGIN IMMEDIATE');

  if (directoryExists(directory)) {
    try { fs.rmdirSync(directory); }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return;

      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (directoryExists(path.dirname(directory))) sync(path.dirname(directory));
  db.prepare('DELETE FROM temporary_chat_allocations WHERE session_id=? AND original_path=?').run(id, directory);
}

function main(request) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.id)) throw new Error('Invalid temporary chat session ID');

  if (!['create', 'remove'].includes(request.action)) throw new Error('Invalid temporary chat action');
  const root = path.resolve(request.root ?? path.join(require('node:os').homedir(), process.env.PIOP_STORAGE_DIRECTORY ?? '.piop'));
  const directory = path.join(root, 'tmp', request.id);

  if (request.action === 'remove' && request.path !== directory) throw new Error('Refusing to remove a directory outside the temporary chat root');

  if (!directoryExists(root)) {
    if (request.action === 'remove') return;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  directoryExists(path.join(root, 'tmp'));
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE)');

    if (request.action === 'create') create(db, root, directory, request.id);
    else remove(db, directory, request.id);
    db.exec('COMMIT');
  } finally { db.close(); }
}

try { main(JSON.parse(process.argv[1])); }
catch (error) { console.error(error.message); process.exitCode = 1; }
