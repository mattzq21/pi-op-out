const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const schema = Type.Object({ containerIdentity: Type.String(), allocation: Type.Object({ target: Type.String() }) });

function present(container, expected) {
  try {
    const info = fs.lstatSync(container, { bigint: true });

    if (!info.isDirectory() || info.isSymbolicLink() || `${info.dev}:${info.ino}` !== expected) throw new Error('Saved worktree container was replaced');

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function targets(root, row) {
  if (path.dirname(row.container) !== path.join(root, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(row.container))) throw new Error('Invalid saved worktree container');
  const record = JSON.parse(row.metadata_json);

  if (record?.creating) throw new Error(`Worktree creation is unfinished: ${row.container}`);

  if (!Check(schema, record)) throw new Error('Invalid saved worktree metadata');

  if (!present(row.container, record.containerIdentity)) return [];
  const saved = [record.allocation.target];

  if (saved.some(target => path.dirname(target) !== row.container || path.normalize(target) !== target)) throw new Error('Saved worktree is outside its container');

  return saved;
}

function list(root) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    const result = { paths: [], warnings: [] };

    for (const row of db.prepare('SELECT container, metadata_json FROM worktree_allocations ORDER BY container').all()) {
      try { result.paths.push(...targets(root, row)); }
      catch (error) { result.warnings.push(`${row.container}: worktree record unavailable: ${error.message}`); }
    }

    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

module.exports = { list };
