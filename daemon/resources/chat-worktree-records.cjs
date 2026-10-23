const path = require('node:path');
const fs = require('node:fs');
const database = require('./session-database.cjs');

/*
 * Durable record of each worktree Piop created for a chat, in the chat_worktrees table of the profile database.
 * The record is also the journal of creation, archive and restore: each Git change is recorded before or after it, so
 * recovery can finish or undo it. This module only reads and writes records; Git work happens in chat_worktrees.ts.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHAT_ID = new RegExp('^' + UUID + '$');
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const STATES = ['preparing', 'active', 'archiving', 'archived', 'restoring'];

/** The Git reference that keeps the saved commit of an archived chat. */
function archiveRef(chatId) { return 'refs/piop/archives/' + chatIdOf(chatId); }

/** A chat branch: piop/ and the shortest free start of the chat ID. Older chats used the full ID. */
const BRANCH = new RegExp(`^piop/([0-9a-f]{4,32}|${UUID}(-${UUID})?)$`);

function chatIdOf(value) {
  if (typeof value !== 'string' || !CHAT_ID.test(value)) throw new Error('Invalid chat ID: ' + value);

  return value;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw new Error(`Invalid ${label} path: ${value}`);

  return value;
}

function branchOf(chatId, value) {
  if (!BRANCH.test(value ?? '')) throw new Error('Invalid chat branch: ' + value);

  return value;
}

function checkArchive(chatId, archive) {
  if (archive?.ref !== archiveRef(chatId) || !COMMIT.test(archive?.commit ?? '')) throw new Error('Invalid chat archive');
}

/** Throws when record is not a valid chat worktree record. Returns it. */
function check(record) {
  if (!record || typeof record !== 'object' || record.version !== 1) throw new Error('Invalid chat worktree record');
  const chatId = chatIdOf(record.chatId);

  absolute(record.repository, 'repository');
  absolute(record.gitCommonDir, 'Git storage');
  absolute(record.worktree, 'worktree');
  branchOf(chatId, record.branch);

  if (!STATES.includes(record.state)) throw new Error('Invalid chat worktree state: ' + record.state);

  if (record.repositoryMissing !== undefined && (record.repositoryMissing !== true || record.state !== 'archiving' || record.archive !== null)) throw new Error('Invalid missing repository archive');
  if (['archiving', 'archived', 'restoring'].includes(record.state) && !record.repositoryMissing) checkArchive(chatId, record.archive);
  else if (record.archive !== null) throw new Error('Only archived chats have a saved commit');

  if ((record.state === 'preparing') !== (typeof record.owner === 'string')) throw new Error('Only preparing chat worktrees have an owner');

  if (record.state === 'restoring') {
    const plan = record.restore;

    if (!plan || typeof plan.reuse !== 'boolean' || !CHAT_ID.test(plan.restoreId ?? '')) throw new Error('Invalid restore plan');
    if (plan.retained !== undefined && plan.retained !== true) throw new Error('Invalid retained worktree restore');
    if (plan.retained && (!plan.reuse || plan.worktree !== record.worktree || plan.branch !== record.branch)) throw new Error('Retained restore must use the shared worktree');
    absolute(plan.worktree, 'restored worktree');
    branchOf(chatId, plan.branch);
  } else if (record.restore !== undefined) throw new Error('Only restoring chats have a restore plan');

  return record;
}

function withDatabase(root, operation) {
  const db = database.open(root);

  try { return operation(db); }
  finally { db.close(); }
}

function selectBody(db, chatId) { return db.prepare('SELECT record_json FROM chat_worktrees WHERE chat_id=?').get(chatIdOf(chatId))?.record_json ?? null; }

/** Returns the worktree record of the chat, or null when Piop did not create a worktree for it. */
function read(root, chatId) {
  const text = withDatabase(root, db => selectBody(db, chatId));

  return text === null ? null : check(JSON.parse(text));
}

/** Returns every chat worktree record. */
function list(root) {
  return withDatabase(root, db => db.prepare('SELECT record_json FROM chat_worktrees ORDER BY chat_id').all()).map(row => check(JSON.parse(row.record_json)));
}

/**
 * Replaces the record of the chat only while it still equals before. A null before expects no record; a null after removes it.
 * Throws when the record changed, so two writers never overwrite each other.
 */
function replace(root, chatId, before, after) {
  chatIdOf(chatId);
  const expected = before === null ? null : JSON.stringify(check(before));
  const next = after === null ? null : JSON.stringify(check(after));

  if (after !== null && after.chatId !== chatId) throw new Error('Chat worktree record belongs to another chat');
  withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    try {
      if (selectBody(db, chatId) !== expected) throw new Error('Chat worktree record changed: ' + chatId);

      if (next === null) db.prepare('DELETE FROM chat_worktrees WHERE chat_id=?').run(chatId);
      else if (expected === null) db.prepare('INSERT INTO chat_worktrees VALUES (?, ?)').run(chatId, next);
      else db.prepare('UPDATE chat_worktrees SET record_json=? WHERE chat_id=?').run(next, chatId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });

  return after;
}

/** Identifies a process across PID reuse: PID and its start time from /proc. */
function processToken(pid = process.pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');

  return `${pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
}

/** True while the process that wrote token still runs. */
function ownerAlive(token) {
  const pid = Number(String(token).split(':')[0]);

  try { return Number.isInteger(pid) && pid > 0 && processToken(pid) === token; }
  catch { return false; }
}

/** Records that this process starts creating a worktree for a new chat. Throws when the chat already has a record. */
function prepare(root, fields) {
  const chatId = chatIdOf(fields?.chatId);

  return replace(root, chatId, null, {
    version: 1, chatId, repository: fields.repository, gitCommonDir: fields.gitCommonDir, worktree: fields.worktree,
    branch: fields.branch, state: 'preparing', archive: null, owner: processToken(),
  });
}

/** Marks the creation of the chat complete. */
function activate(root, chatId) {
  const record = read(root, chatId);

  if (record === null) throw new Error('Chat worktree record is missing: ' + chatId);

  if (record.state === 'active') return record;

  if (record.state !== 'preparing') throw new Error(`Chat worktree is ${record.state}, not being created: ${chatId}`);
  const { owner: _owner, lastError: _error, ...rest } = record;

  return replace(root, chatId, record, { ...rest, state: 'active' });
}

/** Saves the error of a failed cleanup on the record, so recovery and the storage report show it. */
function fail(root, record, message) {
  try { replace(root, record.chatId, record, { ...record, lastError: message }); }
  catch (error) { return `${message}\nCleanup record could not be updated: ${error.message}`; }

  return message;
}

module.exports = { archiveRef, check, read, list, replace, prepare, activate, fail, processToken, ownerAlive };
