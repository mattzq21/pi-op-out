const preparations = require('./fork-preparation-records.cjs');
const records = require('./archive-records.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const moveSchema = Type.Object({ source: Type.String(), destination: Type.String() });

const deletionSchema = Type.Object({ kind: Type.Literal('delete'), container: Type.String(), garbagePath: Type.String(),
  files: Type.Array(Type.Object({ source: Type.String(), staged: Type.String() })) });

const archiveSchema = Type.Object({ kind: Type.Literal('archive'), records: Type.Array(Type.Object({ moves: Type.Array(moveSchema) })) });

const restorationSchema = Type.Object({ moves: Type.Array(moveSchema) });

const forkSchema = Type.Object({ destination: Type.String({ pattern: '\\.jsonl$' }) });

const legacyArchiveSchema = Type.Object({ records: Type.Array(Type.Object({
  file: Type.String({ pattern: '\\.jsonl$' }), destination: Type.String({ pattern: '\\.jsonl$' }),
})) });

const legacyDeletionSchema = Type.Object({ files: Type.Array(Type.Object({
  path: Type.String(), staged: Type.String({ pattern: '^\\d+\\.staged$' }),
})) });

function validate(schema, record) {
  if (!Check(schema, record)) throw new Error('Invalid saved comparison operation');
}

function add(stores, file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Invalid saved comparison location');
  stores.add(file);
}

function present(directory) {
  try { return Boolean(fs.lstatSync(directory)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function moves(stores, records) {
  for (const move of records) {
    if (!move.source.endsWith('.diffs.json')) continue;
    add(stores, move.source);
    add(stores, move.destination);
  }
}

function deletions(root, stores) {
  for (const { record } of require('./deletion-records.cjs').list(root)) {
    if (!record) continue;

    deletionStores(record, stores);
  }

  legacyDeletions(root, stores);
}

function deletionStores(record, stores) {
  validate(deletionSchema, record);

  for (const file of record.files) {
    if (!file.source.endsWith('.diffs.json')) continue;
    add(stores, file.source);
    add(stores, file.staged);

    if (path.dirname(file.staged) !== record.container) throw new Error('Invalid staged comparison location');
    add(stores, path.join(record.garbagePath, path.basename(file.staged)));
  }
}

function legacyDeletions(root, stores) {
  const records = require('./legacy-deletion-records.cjs');
  const directories = new Set([...records.list(root), ...require('./legacy-deletion-locks.cjs').list(root)]);

  for (const directory of directories) {
    if (!present(directory)) continue;
    const record = records.read(root, directory);

    if (!record) throw new Error(`Deletion comparison ownership is unavailable: ${directory}`);

    if (record.kind === 'delete') {
      deletionStores(record, stores);
    } else {
      validate(legacyDeletionSchema, record);

      for (const file of record.files) {
        if (!file.path.endsWith('.diffs.json')) continue;
        add(stores, file.path);
        add(stores, path.join(directory, file.staged));
      }
    }
  }
}

function archives(root, stores) {

  for (const directory of records.list(root)) {
    const record = records.read(directory);

    if (!record) continue;

    validate(archiveSchema, record);

    for (const session of record.records) moves(stores, session.moves);
  }

  legacyArchives(root, stores);
}

function legacyArchives(root, stores) {
  const records = require('./legacy-archive-records.cjs');

  for (const directory of records.list(root)) {
    const record = records.read(root, directory);

    if (!record) {
      if (present(directory)) throw new Error(`Archive comparison ownership is unavailable: ${directory}`);
      continue;
    }

    if (record.version === undefined) {
      validate(legacyArchiveSchema, record);

      for (const session of record.records) {
        add(stores, session.file.replace(/\.jsonl$/, '.diffs.json'));
        add(stores, session.destination.replace(/\.jsonl$/, '.diffs.json'));
      }
    } else if (record.version === 2) {
      if (record.preparing && record.moves === undefined) continue;
      validate(restorationSchema, record);
      moves(stores, record.moves);
    } else throw new Error('Unsupported archived comparison record');
  }
}

function restorations(root, stores) {
  const records = require('./restore-records.cjs');

  for (const file of records.list(root)) {
    const record = records.read(file)?.value;

    validate(restorationSchema, record);
    moves(stores, record.moves);
  }
}

function forks(root, stores) {
  const records = require('./fork-transaction-records.cjs');

  for (const directory of records.list(root)) {
    if (path.dirname(directory) !== path.join(root, 'fork-transactions')) throw new Error('Invalid saved fork directory');
    add(stores, path.join(directory, 'diffs.json'));
    const record = records.read(directory);

    if (!record) continue;

    validate(forkSchema, record);
    add(stores, record.destination.replace(/\.jsonl$/, '.diffs.json'));
  }


  for (const directory of preparations.list(root)) {
    if (!present(directory)) continue;

    for (const file of preparations.files(directory)) if (file.endsWith('.diffs.json')) add(stores, file);
  }
}

function collect(root, stores) {
  deletions(root, stores);
  archives(root, stores);
  restorations(root, stores);
  forks(root, stores);
}

module.exports = { collect };
