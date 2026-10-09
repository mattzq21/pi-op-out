const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const database = require('../session-database.cjs');
const preparations = require('./goal-preparations.cjs');

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal preparation directory changed');

  return `${info.dev}:${info.ino}`;
}

function contentNames(directory) {
  return fs.readdirSync(directory).filter(name => /^(?:goal-objective\.md|attachment-[1-9][0-9]*\.(?:txt|png|jpg|gif|webp))$/.test(name)).sort();
}

function savedContent(directory, name) {
  const file = path.join(directory, name);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });

    if (!before.isFile()) throw new Error('Goal attachment is not a regular file');
    const data = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file, { bigint: true });

    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Goal attachment changed during import');

    return { name, data: data.toString('base64'), digest: createHash('sha256').update(data).digest('hex') };
  } finally { fs.closeSync(descriptor); }
}

function requireReferencedContents(directory, record, files) {
  const names = new Set(files.map(file => file.name));

  if (record.objective === `Read the goal objective file at ${path.join(directory, 'goal-objective.md')} before continuing.` && !names.has('goal-objective.md')) throw new Error('Saved goal objective file is missing');
  const objective = files.find(file => file.name === 'goal-objective.md');

  if (!objective) return;
  const text = Buffer.from(objective.data, 'base64').toString('utf8');
  const prefix = directory + path.sep;

  for (const part of text.split(prefix).slice(1)) {
    const name = part.match(/^attachment-[1-9][0-9]*\.(?:txt|png|jpg|gif|webp)(?=\. Read this file before continuing\.)/)?.[0];

    if (name && !names.has(name)) throw new Error(`Saved goal attachment is missing: ${name}`);
  }
}

function importContents(db, directory, expected, body) {
  const record = JSON.parse(body);

  if (record?.version !== 1 || record.input || Object.hasOwn(record, 'files')) return record;
  const names = contentNames(directory);
  const files = names.map(name => savedContent(directory, name));
  requireReferencedContents(directory, record, files);

  if (identity(directory) !== expected || JSON.stringify(names) !== JSON.stringify(contentNames(directory))) throw new Error('Goal files changed during import');
  db.prepare('UPDATE goal_preparations SET record_json=? WHERE directory=? AND identity=? AND record_json=?')
    .run(JSON.stringify({ ...record, files }), directory, expected, body);
  const current = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?').get(directory, expected);

  return current?.record_json ? JSON.parse(current.record_json) : undefined;
}

function read(root, directory) {
  const record = preparations.read(root, directory);

  if (!record || record.version !== 1 || record.input || Object.hasOwn(record, 'files')) return record;
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return record; throw error; }

  const db = database.open(root);

  try {
    const row = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?').get(directory, expected);

    return row?.record_json ? importContents(db, directory, expected, row.record_json) : undefined;
  } finally { db.close(); }
}

module.exports = { read };
