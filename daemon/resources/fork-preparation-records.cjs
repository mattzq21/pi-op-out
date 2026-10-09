const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const filesSchema = Type.Array(Type.String());

function profile(directory) { return path.dirname(path.dirname(directory)); }

function open(preparation) {
  const db = database.open(profile(preparation));

  try {
    db.exec('CREATE TABLE IF NOT EXISTS fork_preparation_files (preparation TEXT PRIMARY KEY, identity TEXT NOT NULL, files_json TEXT NOT NULL)');

    return db;
  } catch (error) { db.close(); throw error; }
}

function directoryIdentity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Fork preparation directory changed');

  return `${info.dev}:${info.ino}`;
}

function importFiles(directory, files) {
  directoryIdentity(directory);

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) throw new Error('Fork preparation contains an unresolved link');

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) importFiles(file, files);
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.diffs.json'))) files.push(file);
  }
}

function files(preparation) {
  if (path.basename(path.dirname(preparation)) !== 'fork-preparations') throw new Error('Invalid fork preparation location');
  const identity = directoryIdentity(preparation);
  const db = open(preparation);

  try {
    db.exec('BEGIN IMMEDIATE');
    let row = db.prepare('SELECT identity, files_json FROM fork_preparation_files WHERE preparation=?').get(preparation);

    if (!row) {
      const paths = [];
      importFiles(preparation, paths);
      row = { identity, files_json: JSON.stringify(paths) };
      db.prepare('INSERT INTO fork_preparation_files VALUES (?, ?, ?)').run(preparation, identity, row.files_json);
    }

    if (row.identity !== directoryIdentity(preparation)) throw new Error('Saved fork preparation was replaced');
    db.exec('COMMIT');

    const paths = JSON.parse(row.files_json);

    if (!Check(filesSchema, paths)) throw new Error('Invalid saved fork preparation files');

    for (const file of paths) validateFile(preparation, file);

    return paths;
  } finally { db.close(); }
}

function validateFile(preparation, file) {
  if (!path.isAbsolute(file)) throw new Error('Invalid saved fork preparation file');
  const relative = path.relative(preparation, file);

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Saved fork file is outside its preparation');

  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error('Saved fork preparation file changed');
}

function importRecords(db, preparation) {
  const migration = `fork-checkpoints:${preparation}`;

  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const directory = path.join(preparation, 'checkpoint-owners');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    db.prepare('INSERT INTO fork_preparation_checkpoints VALUES (?, ?, ?) ON CONFLICT(preparation, session_id) DO NOTHING')
      .run(preparation, entry.name.slice(0, -5), fs.readFileSync(path.join(directory, entry.name), 'utf8'));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function read(preparation) {
  const db = database.open(profile(preparation));

  try {
    db.exec('BEGIN IMMEDIATE');
    importRecords(db, preparation);
    const rows = db.prepare('SELECT session_id, record_json FROM fork_preparation_checkpoints WHERE preparation=?').all(preparation);
    db.exec('COMMIT');

    return rows;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function remove(preparation) {
  const db = open(preparation);

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM fork_preparation_checkpoints WHERE preparation=?').run(preparation);
    db.prepare('DELETE FROM fork_preparation_files WHERE preparation=?').run(preparation);
    db.prepare('DELETE FROM fork_preparations WHERE directory=?').run(preparation);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM fork_preparations ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

module.exports = { read, remove, list, files };
