import fs from 'node:fs';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import type { TSchema } from 'typebox';

export interface GoalAttachment { name: string; text?: string; image?: { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | null }

export interface GoalDraft { objective: string; attachments: GoalAttachment[] }

export interface GoalPreparation {
  version: 1; submissionId: string; digest: string; objective: string; sessionId: string; sessionPath?: string; cwd: string;
  goalId?: string; expectedState?: string; input?: GoalDraft; files?: Array<{ name: string; data: string; digest: string }>;
}


const imageSchema = Type.Object({ data: Type.String(), mimeType: Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg'), Type.Literal('image/gif'), Type.Literal('image/webp')]) });

const attachmentSchema = Type.Object({ name: Type.String(), text: Type.Optional(Type.String()), image: Type.Optional(Type.Union([Type.Null(), imageSchema])) });

// A goal as the user wrote it: the objective and its attachments.
const draftSchema = Type.Object({ objective: Type.String(), attachments: Type.Array(attachmentSchema) });

const savedFileSchema = Type.Object({ name: Type.String({ pattern: '^(?:goal-objective\\.md|attachment-[1-9][0-9]*\\.(?:txt|png|jpg|gif|webp))$' }), data: Type.String(), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) });

// What the daemon saved to make a goal folder again: the goal, its chat, and the input or the files of the folder.
const preparationSchema = Type.Object({
  version: Type.Literal(1), submissionId: Type.String(), digest: Type.String(), objective: Type.String(), sessionId: Type.String(),
  sessionPath: Type.Optional(Type.String()), cwd: Type.String(), goalId: Type.Optional(Type.String()), expectedState: Type.Optional(Type.String()),
  input: Type.Optional(draftSchema), files: Type.Optional(Type.Array(savedFileSchema)),
});

// The saved preparation text as a preparation.
function parsePreparation(text: string): GoalPreparation {
  const preparation = JSON.parse(text);

  if (!Check(preparationSchema, preparation)) throw new Error('Damaged goal preparation retained');

  return preparation;
}

function withDatabase(root, operation) {
  return operation(database.connection(root));
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal preparation directory changed');

  return `${info.dev}:${info.ino}`;
}

function read(root: string, directory: string): GoalPreparation | undefined {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return missingDirectoryRecord(root, directory); throw error; }

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (!row) {
      if (db.prepare('SELECT 1 FROM goal_preparations WHERE directory=? AND identity<>? AND record_json IS NOT NULL').get(directory, expected)) throw new Error('Saved goal preparation directory was replaced');

      return undefined;
    }

    return row.record_json === null ? undefined : parsePreparation(row.record_json);
  });
}

function missingDirectoryRecord(root, directory) {
  return withDatabase(root, db => {
    const rows = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND record_json IS NOT NULL').all(directory);

    if (rows.length > 1) throw new Error('More than one saved goal preparation refers to the missing directory');

    return rows.length ? parsePreparation(rows[0].record_json) : undefined;
  });
}

const save = onMainThread('goal-preparations.save', (root: string, directory: string, record: GoalPreparation, destination: string = directory): string => {
  if (!Check(preparationSchema, record)) throw new Error('Invalid goal preparation');
  const expected = identity(directory);
  withDatabase(root, db => db.prepare('INSERT INTO goal_preparations VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json')
    .run(destination, expected, JSON.stringify(record)));

  return expected;
});

function retained(root: string, directory: string, expected: string): boolean {
  return withDatabase(root, db => Boolean(db.prepare('SELECT 1 FROM goal_preparations WHERE directory=? AND identity=? AND record_json IS NOT NULL').get(directory, expected)));
}

const remove = onMainThread('goal-preparations.remove', (root: string, directory: string, expected: string): void => {
  withDatabase(root, db => db.prepare('DELETE FROM goal_preparations WHERE directory=? AND identity=?').run(directory, expected));
});

export { draftSchema, parsePreparation, read, save, retained, remove };
