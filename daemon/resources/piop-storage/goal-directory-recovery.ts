import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as database from '../session-database.ts';
import * as assets from './goal-assets.ts';
import * as ownership from './goal-ownership.ts';
import * as preparations from './goal-preparations.ts';

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

// A goal folder that the daemon makes again from its saved preparation: the folder it fills first, the identities of
// the old and the new folder, and the saved preparation text.
const recordSchema = Type.Object({ staging: Type.String(), previous: identitySchema, current: identitySchema, preparation: Type.String() });

function saved(root, directory) {
  const text = database.goalDirectoryRecovery(root, directory);

  if (text === undefined) return undefined;
  const record = JSON.parse(text);

  if (!Check(recordSchema, record)) throw new Error('Damaged goal folder recovery retained: ' + directory);

  return record;
}

function validate(root, directory, record) {
  if (!assets.validPath(root, directory) || !assets.validPath(root, record.staging) || path.dirname(record.staging) !== path.dirname(directory) || record.staging === directory) throw new Error('Invalid goal folder recovery');
}

function checkPreparation(root, directory, record) {
  const key = createHash('sha256').update(directory).digest('hex');

  if (database.goalReclamation(root, key) !== undefined) throw new Error('Goal folder deletion must finish before recovery');
  const row = database.goalPreparation(root, directory, record.previous);

  if (row?.record_json !== record.preparation) throw new Error('Saved goal preparation changed during recovery');
}

function sync(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function finish(root, directory) {
  database.transaction(root, 'IMMEDIATE', () => {
    const record = saved(root, directory);

    if (!record) return;
    validate(root, directory, record);

    if (assets.identity(directory) !== record.current) throw new Error('Recovered goal folder was replaced');
    sync(directory); sync(path.dirname(directory));
    checkPreparation(root, directory, record);
    database.moveGoalDirectoryRecords(root, directory, record);
  });
}

function recoverPublished(root, directory) {
  const record = saved(root, directory);

  if (!record || !assets.exists(directory)) return;
  const release = assets.acquire(root);

  try { finish(root, directory); }
  finally { release(); }
}

function begin(root, directory) {
  if (!assets.validPath(root, directory)) throw new Error('Invalid goal recovery destination');
  const pending = saved(root, directory);

  if (pending) {
    validate(root, directory, pending);
    checkPreparation(root, directory, pending);

    if (assets.identity(pending.staging) !== pending.current) throw new Error('Goal recovery staging folder was replaced');

    return pending;
  }

  return prepare(root, directory);
}

function prepare(root, directory) {
  const rows = database.goalPreparationsOf(root, directory);

  if (rows.length !== 1) throw new Error('Goal folder recovery requires one saved preparation');
  const preparation = preparations.parsePreparation(rows[0].record_json);

  if (!preparation.input && !preparation.files) throw new Error('Goal attachment contents were not saved');
  const allocation = ownership.allocate(root, path.dirname(directory));
  ownership.save(root, allocation.directory, { version: 1, kind: 'goal-assets', owners: [{ sessionId: preparation.sessionId, sessionPath: preparation.sessionPath }] });
  const record = { staging: allocation.directory, previous: rows[0].identity, current: allocation.identity, preparation: rows[0].record_json };
  checkPreparation(root, directory, record);
  sync(record.staging); sync(path.dirname(directory));
  database.saveGoalDirectoryRecovery(root, directory, record);

  return record;
}

export { begin, finish, recoverPublished };
