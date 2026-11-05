const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

// The goal folders whose attachments a chat or a goal folder uses, each with the identity of the folder it used.
const contractSchema = Type.Object({
  version: Type.Literal(1), policy: Type.Literal('shared-profile'),
  directories: Type.Array(Type.Object({ path: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) })),
});

function validContract(value) { return Check(contractSchema, value); }

// The saved contract text as a contract.
function parseContract(text) {
  const contract = JSON.parse(text);

  if (!validContract(contract)) throw new Error('Invalid goal asset dependency contract');

  return contract;
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal dependency directory changed');

  return `${info.dev}:${info.ino}`;
}

function value(row) { return row && row.record_json !== null ? parseContract(row.record_json) : undefined; }

function read(root, directory) {
  const expected = identity(directory);

  return value(database.goalDependency(root, directory, expected));
}

const save = onMainThread('goal-dependencies.save', (root, directory, record) => {
  if (!validContract(record)) throw new Error('Invalid goal asset dependency contract');
  const expected = identity(directory);

  database.saveGoalDependency(root, directory, expected, JSON.stringify(record));
});

function retained(root, directory, expected) {
  return database.goalDependencyRetained(root, directory, expected);
}

const remove = onMainThread('goal-dependencies.remove', (root, directory, expected) => {
  removeTextFiles(root, directory, expected);
  database.removeGoalDependency(root, directory, expected);
});

function validNames(names) {
  if (!Array.isArray(names) || names.some(name => !/^[^/\\]+\.(md|txt)$/.test(name) || path.basename(name) !== name)) throw new Error('Invalid goal text file list');

  return names;
}

function textFiles(root, directory) {
  const expected = identity(directory);

  const names = database.goalTextFileNames(root, directory, expected);

  if (names === undefined && database.goalDirectoryUnpublished(root, directory, expected)) return [];

  if (names === undefined) throw new Error('Goal text files are not registered');

  return validNames(JSON.parse(names));
}

function readContents(directory, names) {
  return validNames(names).map(name => {
    const file = path.join(directory, name);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

    try {
      const before = fs.fstatSync(descriptor, { bigint: true });

      if (!before.isFile()) throw new Error('Goal text is not a regular file');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
      const after = fs.lstatSync(file, { bigint: true });

      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Goal text changed during import');

      return { name, text };
    } finally { fs.closeSync(descriptor); }
  });
}

function textContents(root, directory) {
  const expected = identity(directory);

  const contents = database.goalTextContents(root, directory, expected);

  if (contents === undefined && database.goalDirectoryUnpublished(root, directory, expected)) return [];

  if (contents === undefined) throw new Error('Goal text contents are not registered');

  return JSON.parse(contents);
}

function saveTextFiles(root, directory, names, destination = directory) {
  return publishText(root, directory, names, destination);
}

function savePreparedText(root, directory, names, preparation, destination = directory) {
  const input = JSON.parse(preparation);
  const ownership = { version: 1, kind: "goal-assets", owners: [{ sessionId: input.sessionId, sessionPath: input.sessionPath }] };

  return publishText(root, directory, names, destination, preparation, ownership);
}

function publishText(root, directory, names, destination, preparation, ownership) {
  const expected = identity(directory);
  const contents = readContents(directory, names);

  if (identity(directory) !== expected) throw new Error('Goal text directory changed during publication');
  saveText(root, destination, expected, names, contents, preparation, ownership);

  return expected;
}

const saveText = onMainThread('goal-dependencies.saveText', (root, destination, expected, names, contents, preparation, ownership) => {
  database.transaction(root, 'IMMEDIATE', () => {
    if (preparation !== undefined) {
      database.saveGoalOwnership(root, destination, expected, JSON.stringify(ownership));
      database.saveGoalPreparation(root, destination, expected, preparation);
    }

    database.saveGoalTexts(root, destination, expected, names, contents);
  });
});

const removeTextFiles = onMainThread('goal-dependencies.removeTextFiles', (root, directory, expected) => {
  database.removeGoalTexts(root, directory, expected);
});

const removePreparedText = onMainThread('goal-dependencies.removePreparedText', (root, directory, expected) => {
  database.transaction(root, 'IMMEDIATE', () => {
    database.removeGoalPreparation(root, directory, expected);
    database.removeGoalTexts(root, directory, expected);
    database.removeGoalOwnership(root, directory, expected);
  });
});

function matchesDirectory(root, directory, previous, current) {
  if (previous === current) return true;

  return database.goalDirectoryRemade(root, directory, previous, current);
}

module.exports = { contractSchema, validContract, parseContract, read, save, retained, remove, textFiles, textContents, saveTextFiles, savePreparedText, removeTextFiles, removePreparedText, matchesDirectory };
