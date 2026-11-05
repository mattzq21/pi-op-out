import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Check } from 'typebox/value';
import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import { randomBytes } from 'node:crypto';

// The chats that use the attachments of a goal folder, and the deleted chats that used them.
const recordSchema = Type.Object({
  version: Type.Literal(1), kind: Type.Literal('goal-assets'),
  owners: Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Optional(Type.String()) })),
  retiredOwners: Type.Optional(Type.Array(Type.String())),
});

export type GoalOwnershipRecord = Static<typeof recordSchema>;

function parsed(directory: string, text: string): GoalOwnershipRecord {
  const record = JSON.parse(text);

  if (!Check(recordSchema, record)) throw new Error(`Damaged goal ownership retained: ${directory}`);

  return record;
}

function identity(directory: string): string {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal ownership directory changed');

  return `${info.dev}:${info.ino}`;
}

function read(root: string, directory: string): GoalOwnershipRecord | undefined {
  let expected: string;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return missingDirectoryRecord(root, directory); throw error; }

  const row = database.goalOwnership(root, directory, expected);

  if (!row) {
    if (database.goalOwnershipReplaced(root, directory, expected)) throw new Error('Saved goal ownership directory was replaced');

    return undefined;
  }

  return row.record_json === null ? undefined : parsed(directory, row.record_json);
}

function missingDirectoryRecord(root: string, directory: string): GoalOwnershipRecord | undefined {
  const row = missingDirectoryRow(root, directory);

  return row ? parsed(directory, row.record_json) : undefined;
}

function savedIdentity(root: string, directory: string): string | undefined { return missingDirectoryRow(root, directory)?.identity; }

function missingDirectoryRow(root: string, directory: string): database.GoalIdentityRow | undefined {
  const rows = database.goalOwnershipsOf(root, directory);

  if (rows.length > 1) throw new Error('More than one saved goal owner record refers to the missing directory');

  return rows[0];
}

const save = onMainThread('goal-ownership.save', (root: string, directory: string, record: GoalOwnershipRecord | undefined, destination: string = directory): string => {
  if (record !== undefined && !Check(recordSchema, record)) throw new Error('Invalid goal ownership record');
  const expected = identity(directory);
  database.saveGoalOwnership(root, destination, expected, record === undefined ? null : JSON.stringify(record));

  return expected;
});

function retained(root: string, directory: string, expected: string): boolean {
  return database.goalOwnershipRetained(root, directory, expected);
}

const remove = onMainThread('goal-ownership.remove', (root: string, directory: string, expected: string): void => {
  database.removeGoalOwnership(root, directory, expected);
});

const reserveDirectory = onMainThread('goal-ownership.reserveDirectory', (root: string, directory: string): number => database.reserveGoalDirectory(root, directory));

function allocate(root: string, parent: string): { directory: string; identity: string } {
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

const publishAllocation = onMainThread('goal-ownership.publishAllocation', (root: string, directory: string): string => {
  const expected = identity(directory);
  database.publishGoalDirectory(root, directory, expected);

  return expected;
});

function directories(root: string, sessionId?: string): string[] {
  return database.goalOwnedDirectories(root, sessionId);
}

export { read, save, retained, remove, directories, allocate, savedIdentity };
