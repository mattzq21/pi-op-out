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

function files(preparation) {
  if (path.basename(path.dirname(preparation)) !== 'fork-preparations') throw new Error('Invalid fork preparation location');
  const db = open(preparation);

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT identity, files_json FROM fork_preparation_files WHERE preparation=?').get(preparation);

    if (!row) throw new Error('Fork preparation files are not registered');

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

function read(preparation) {
  const db = database.open(profile(preparation));

  try {
    db.exec('BEGIN IMMEDIATE');
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
    require('./transcript-references.cjs').removeDirectory(db, preparation);
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
