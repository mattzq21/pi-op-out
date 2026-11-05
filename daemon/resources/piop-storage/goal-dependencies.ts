import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { GoalOwnershipRecord } from './goal-ownership.ts';
import { Check } from 'typebox/value';
import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';

// The goal folders whose attachments a chat or a goal folder uses, each with the identity of the folder it used.
const contractSchema = Type.Object({
  version: Type.Literal(1), policy: Type.Literal('shared-profile'),
  directories: Type.Array(Type.Object({ path: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) })),
});

export type GoalContract = Static<typeof contractSchema>;

function validContract(value: unknown): value is GoalContract { return Check(contractSchema, value); }

// The saved contract text as a contract.
function parseContract(text: string): GoalContract {
  const contract = JSON.parse(text);

  if (!validContract(contract)) throw new Error('Invalid goal asset dependency contract');

  return contract;
}

function identity(directory: string): string {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal dependency directory changed');

  return `${info.dev}:${info.ino}`;
}

function value(row: database.GoalRecordRow | undefined): GoalContract | undefined { return row && row.record_json !== null ? parseContract(row.record_json) : undefined; }

function read(root: string, directory: string): { directories: Array<{ path: string; identity: string }> } | undefined {
  const expected = identity(directory);

  return value(database.goalDependency(root, directory, expected));
}

const save = onMainThread('goal-dependencies.save', (root: string, directory: string, record: GoalContract): void => {
  if (!validContract(record)) throw new Error('Invalid goal asset dependency contract');
  const expected = identity(directory);

  database.saveGoalDependency(root, directory, expected, JSON.stringify(record));
});

function retained(root: string, directory: string, expected: string): boolean {
  return database.goalDependencyRetained(root, directory, expected);
}

const remove = onMainThread('goal-dependencies.remove', (root: string, directory: string, expected: string) => {
  removeTextFiles(root, directory, expected);
  database.removeGoalDependency(root, directory, expected);
});

function validNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.some(name => !/^[^/\\]+\.(md|txt)$/.test(name) || path.basename(name) !== name)) throw new Error('Invalid goal text file list');

  return names;
}

function textFiles(root: string, directory: string): string[] {
  const expected = identity(directory);

  const names = database.goalTextFileNames(root, directory, expected);

  if (names === undefined && database.goalDirectoryUnpublished(root, directory, expected)) return [];

  if (names === undefined) throw new Error('Goal text files are not registered');

  return validNames(JSON.parse(names));
}

function readContents(directory: string, names: string[]): Array<{ name: string; text: string }> {
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

function textContents(root: string, directory: string): Array<{ name: string; text: string }> {
  const expected = identity(directory);

  const contents = database.goalTextContents(root, directory, expected);

  if (contents === undefined && database.goalDirectoryUnpublished(root, directory, expected)) return [];

  if (contents === undefined) throw new Error('Goal text contents are not registered');

  return JSON.parse(contents);
}

function saveTextFiles(root: string, directory: string, names: string[], destination: string = directory): string {
  return publishText(root, directory, names, destination);
}

function savePreparedText(root: string, directory: string, names: string[], preparation: string, destination: string = directory): string {
  const input = JSON.parse(preparation);
  const ownership: GoalOwnershipRecord = { version: 1, kind: "goal-assets", owners: [{ sessionId: input.sessionId, sessionPath: input.sessionPath }] };

  return publishText(root, directory, names, destination, preparation, ownership);
}

function publishText(root: string, directory: string, names: string[], destination: string, preparation?: string, ownership?: GoalOwnershipRecord): string {
  const expected = identity(directory);
  const contents = readContents(directory, names);

  if (identity(directory) !== expected) throw new Error('Goal text directory changed during publication');
  saveText(root, destination, expected, names, contents, preparation, ownership);

  return expected;
}

const saveText = onMainThread('goal-dependencies.saveText', (root: string, destination: string, expected: string, names: string[], contents: Array<{ name: string; text: string }>, preparation: string | undefined, ownership: GoalOwnershipRecord | undefined): void => {
  database.transaction(root, 'IMMEDIATE', () => {
    if (preparation !== undefined) {
      database.saveGoalOwnership(root, destination, expected, JSON.stringify(ownership));
      database.saveGoalPreparation(root, destination, expected, preparation);
    }

    database.saveGoalTexts(root, destination, expected, names, contents);
  });
});

const removeTextFiles = onMainThread('goal-dependencies.removeTextFiles', (root: string, directory: string, expected: string): void => {
  database.removeGoalTexts(root, directory, expected);
});

const removePreparedText = onMainThread('goal-dependencies.removePreparedText', (root: string, directory: string, expected: string): void => {
  database.transaction(root, 'IMMEDIATE', () => {
    database.removeGoalPreparation(root, directory, expected);
    database.removeGoalTexts(root, directory, expected);
    database.removeGoalOwnership(root, directory, expected);
  });
});

function matchesDirectory(root: string, directory: string, previous: string, current: string): boolean {
  if (previous === current) return true;

  return database.goalDirectoryRemade(root, directory, previous, current);
}

export { contractSchema, validContract, parseContract, read, save, retained, remove, textFiles, textContents, saveTextFiles, savePreparedText, removeTextFiles, removePreparedText, matchesDirectory };
