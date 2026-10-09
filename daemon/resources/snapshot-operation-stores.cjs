const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Parse } = require('typebox/value');

const moveSchema = Type.Object({ source: Type.String(), destination: Type.String() });

const deletionSchema = Type.Object({ kind: Type.Literal('delete'), container: Type.String(), garbagePath: Type.String(),
  files: Type.Array(Type.Object({ source: Type.String(), staged: Type.String() })) });

const archiveSchema = Type.Object({ kind: Type.Literal('archive'), records: Type.Array(Type.Object({ moves: Type.Array(moveSchema) })) });

const restorationSchema = Type.Object({ moves: Type.Array(moveSchema) });

const forkSchema = Type.Object({ destination: Type.String({ pattern: '\\.jsonl$' }) });

const legacyArchiveSchema = Type.Object({ records: Type.Array(Type.Object({
  file: Type.String({ pattern: '\\.jsonl$' }), destination: Type.String({ pattern: '\\.jsonl$' }),
})) });

function add(stores, file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Invalid saved comparison location');
  stores.add(file);
}

function moves(stores, records) {
  for (const move of records) {
    if (!move.source.endsWith('.diffs.json')) continue;
    add(stores, move.source);
    add(stores, move.destination);
  }
}

function legacyDirectory(directory, stores) {
  let entries;

  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Saved comparison directory changed');
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }

  for (const entry of entries) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) legacyDirectory(file, stores);
    else if (entry.name.endsWith('.diffs.json')) add(stores, file);
  }
}

function deletions(root, stores) {
  for (const { record } of require('./deletion-records.cjs').list(root)) {
    if (!record) continue;

    Parse(deletionSchema, record);

    for (const file of record.files) {
      if (!file.source.endsWith('.diffs.json')) continue;
      add(stores, file.source);
      add(stores, file.staged);

      if (path.dirname(file.staged) !== record.container) throw new Error('Invalid staged comparison location');
      add(stores, path.join(record.garbagePath, path.basename(file.staged)));
    }
  }

  for (const directory of require('./legacy-deletion-records.cjs').list(root)) legacyDirectory(directory, stores);
}

function archives(root, stores) {
  const records = require('./archive-records.cjs');

  for (const directory of records.list(root)) {
    const record = records.read(directory);

    if (!record) continue;

    Parse(archiveSchema, record);

    for (const session of record.records) moves(stores, session.moves);
  }

  legacyArchives(root, stores);
}

function legacyArchives(root, stores) {
  const records = require('./legacy-archive-records.cjs');

  for (const directory of records.list(root)) {
    const record = records.read(root, directory);

    if (!record) {
      if (fs.existsSync(directory)) throw new Error(`Archive comparison ownership is unavailable: ${directory}`);
      continue;
    }

    if (record.version === undefined) {
      Parse(legacyArchiveSchema, record);

      for (const session of record.records) {
        add(stores, session.file.replace(/\.jsonl$/, '.diffs.json'));
        add(stores, session.destination.replace(/\.jsonl$/, '.diffs.json'));
      }
    } else if (record.version === 2) {
      if (record.preparing && record.moves === undefined) continue;
      Parse(restorationSchema, record);
      moves(stores, record.moves);
    } else throw new Error('Unsupported archived comparison record');
  }
}

function restorations(root, stores) {
  const records = require('./restore-records.cjs');

  for (const file of records.list(root)) {
    const record = records.read(file)?.value;

    Parse(restorationSchema, record);
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

    Parse(forkSchema, record);
    add(stores, record.destination.replace(/\.jsonl$/, '.diffs.json'));
  }

  for (const directory of require('./fork-preparation-records.cjs').list(root)) legacyDirectory(directory, stores);
}

function collect(root, stores) {
  deletions(root, stores);
  archives(root, stores);
  restorations(root, stores);
  forks(root, stores);
}

module.exports = { collect };
