const fs = require('node:fs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');

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
function parsePreparation(text) {
  const preparation = JSON.parse(text);

  if (!Check(preparationSchema, preparation)) throw new Error('Damaged goal preparation retained');

  return preparation;
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal preparation directory changed');

  return `${info.dev}:${info.ino}`;
}

function read(root, directory) {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return missingDirectoryRecord(root, directory); throw error; }

  const row = database.goalPreparation(root, directory, expected);

  if (!row) {
    if (database.goalPreparationReplaced(root, directory, expected)) throw new Error('Saved goal preparation directory was replaced');

    return undefined;
  }

  return row.record_json === null ? undefined : parsePreparation(row.record_json);
}

function missingDirectoryRecord(root, directory) {
  const rows = database.goalPreparationsOf(root, directory);

  if (rows.length > 1) throw new Error('More than one saved goal preparation refers to the missing directory');

  return rows.length ? parsePreparation(rows[0].record_json) : undefined;
}

const save = onMainThread('goal-preparations.save', (root, directory, record, destination = directory) => {
  if (!Check(preparationSchema, record)) throw new Error('Invalid goal preparation');
  const expected = identity(directory);
  database.saveGoalPreparation(root, destination, expected, JSON.stringify(record));

  return expected;
});

function retained(root, directory, expected) {
  return database.goalPreparationRetained(root, directory, expected);
}

const remove = onMainThread('goal-preparations.remove', (root, directory, expected) => {
  database.removeGoalPreparation(root, directory, expected);
});

module.exports = { draftSchema, parsePreparation, read, save, retained, remove };
