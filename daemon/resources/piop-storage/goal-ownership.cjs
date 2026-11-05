const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');
const { randomBytes } = require('node:crypto');

// The chats that use the attachments of a goal folder, and the deleted chats that used them.
const recordSchema = Type.Object({
  version: Type.Literal(1), kind: Type.Literal('goal-assets'),
  owners: Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Optional(Type.String()) })),
  retiredOwners: Type.Optional(Type.Array(Type.String())),
});

function parsed(directory, text) {
  const record = JSON.parse(text);

  if (!Check(recordSchema, record)) throw new Error(`Damaged goal ownership retained: ${directory}`);

  return record;
}

function withDatabase(root, operation) {
  return operation(database.connection(root));
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal ownership directory changed');

  return `${info.dev}:${info.ino}`;
}

function read(root, directory) {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return missingDirectoryRecord(root, directory); throw error; }

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_ownership WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (!row) {
      assertSavedIdentity(db, directory, expected);

      return undefined;
    }

    return row.record_json === null ? undefined : parsed(directory, row.record_json);
  });
}

function assertSavedIdentity(db, directory, expected) {
  if (db.prepare('SELECT 1 FROM goal_ownership WHERE directory=? AND identity<>? AND record_json IS NOT NULL').get(directory, expected)) throw new Error('Saved goal ownership directory was replaced');
}

function missingDirectoryRecord(root, directory) {
  const row = missingDirectoryRow(root, directory);

  return row ? parsed(directory, row.record_json) : undefined;
}

function savedIdentity(root, directory) { return missingDirectoryRow(root, directory)?.identity; }

function missingDirectoryRow(root, directory) {
  return withDatabase(root, db => {
    const rows = db.prepare('SELECT identity, record_json FROM goal_ownership WHERE directory=? AND record_json IS NOT NULL').all(directory);

    if (rows.length > 1) throw new Error('More than one saved goal owner record refers to the missing directory');

    return rows[0];
  });
}

const save = onMainThread('goal-ownership.save', (root, directory, record, destination = directory) => {
  if (record !== undefined && !Check(recordSchema, record)) throw new Error('Invalid goal ownership record');
  const expected = identity(directory);
  withDatabase(root, db => db.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json')
    .run(destination, expected, record === undefined ? null : JSON.stringify(record)));

  return expected;
});

function retained(root, directory, expected) {
  return withDatabase(root, db => Boolean(db.prepare('SELECT 1 FROM goal_ownership WHERE directory=? AND identity=? AND record_json IS NOT NULL').get(directory, expected)));
}

const remove = onMainThread('goal-ownership.remove', (root, directory, expected) => {
  withDatabase(root, db => db.prepare('DELETE FROM goal_ownership WHERE directory=? AND identity=?').run(directory, expected));
});

const reserveDirectory = onMainThread('goal-ownership.reserveDirectory', (root, directory) => Number(withDatabase(root, db => db.prepare('INSERT INTO goal_ownership VALUES (?, ?, NULL) ON CONFLICT DO NOTHING').run(directory, '').changes)));

function allocate(root, parent) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const directory = path.join(parent, `goal-${randomBytes(3).toString('hex')}`);
    const reserved = reserveDirectory(root, directory);

    if (!reserved) continue;

    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      remove(root, directory, '');

      if (error.code === 'EEXIST') continue;
      throw error;
    }

    const expected = publishAllocation(root, directory);

    return { directory, identity: expected };
  }

  throw new Error('Could not allocate goal attachment storage');
}

const publishAllocation = onMainThread('goal-ownership.publishAllocation', (root, directory) => {
  const expected = identity(directory);
  withDatabase(root, db => database.transaction(db, 'IMMEDIATE', () => {
    db.prepare('INSERT INTO goal_ownership VALUES (?, ?, NULL)').run(directory, expected);
    db.prepare("INSERT INTO goal_text_files VALUES (?, ?, '[]')").run(directory, expected);
    db.prepare("INSERT INTO goal_text_contents VALUES (?, ?, '[]')").run(directory, expected);
    db.prepare("DELETE FROM goal_ownership WHERE directory=? AND identity=''").run(directory);
  }));

  return expected;
});

function directories(root, sessionId) {
  return withDatabase(root, db => {
    const rows = sessionId === undefined
      ? db.prepare('SELECT DISTINCT directory FROM goal_ownership').all()
      : db.prepare(`SELECT DISTINCT directory FROM goal_ownership
        WHERE EXISTS (SELECT 1 FROM json_each(record_json, '$.owners') AS owner
          WHERE json_extract(owner.value, '$.sessionId')=?)`).all(sessionId);

    return rows.map(row => row.directory);
  });
}

module.exports = { read, save, retained, remove, directories, allocate, savedIdentity };
