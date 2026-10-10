import * as chatStoreFs from 'node:fs';
import { DatabaseSync as ChatStoreDatabase } from 'node:sqlite';
import { mkdir as chatStoreMkdir, lstat as chatStoreLstat, open as chatStoreOpen } from 'node:fs/promises';
import { constants as chatStoreConstants } from 'node:fs';
import { join as chatStoreJoin } from 'node:path';
import { createHash as chatStoreHash, randomUUID as chatStoreUuid } from 'node:crypto';
import { spawn as chatStoreSpawn } from 'node:child_process';

const chatGptDatabases = new Map();

function chatGptDatabase(directory) {
  const previous = chatGptDatabases.get(directory);

  if (previous) return previous;
  chatStoreFs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (!chatStoreFs.lstatSync(directory).isDirectory()) throw new Error('Invalid ChatGPT storage directory');
  const file = chatStoreJoin(directory, 'chats.sqlite');
  const descriptor = chatStoreFs.openSync(file, chatStoreConstants.O_CREAT | chatStoreConstants.O_RDWR | chatStoreConstants.O_NOFOLLOW, 0o600);
  chatStoreFs.closeSync(descriptor);
  chatStoreFs.chmodSync(file, 0o600);
  const database = new ChatStoreDatabase(file);

  try {
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS chat_records (chat_id TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE IF NOT EXISTS chat_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    chatGptDatabases.set(directory, database);

    return database;
  } catch (error) { database.close(); throw error; }
}

export function chatGptStoredDevice(directory) {
  const database = chatGptDatabase(directory);
  const saved = database.prepare("SELECT value FROM chat_metadata WHERE key='device'").get();

  if (saved) return saved.value;
  const device = chatStoreUuid();

  database.prepare("INSERT INTO chat_metadata VALUES ('device', ?) ON CONFLICT(key) DO NOTHING").run(device);

  return database.prepare("SELECT value FROM chat_metadata WHERE key='device'").get().value;
}

export function chatGptStoredCount(directory) {
  return chatGptDatabase(directory).prepare('SELECT chat_id FROM chat_records').all()
    .filter(row => chatGptRecordId(row.chat_id)).length;
}

function chatGptDatabaseData(database, id) {
  const row = database.prepare('SELECT record_json FROM chat_records WHERE chat_id=?').get(chatGptId(id));


  return row?.record_json ?? null;
}

export const chatGptWrites = new Map();

export const chatGptLeases = new Map();

export const chatGptLeaseOperations = new Map();

export const chatGptRevisions = new WeakMap();

export const chatGptSaveErrors = new Map();

function chatGptLeaseBusy(key, lease) { return lease.busy > 0 || chatGptActive.has(key) || chatGptStopping.has(key); }

function chatGptLeaseLive(key, lease) { return Boolean(lease && (lease.expires > Date.now() || chatGptLeaseBusy(key, lease))); }

function chatGptLeaseOwner(request) { return JSON.stringify([request.clientId, chatGptId(request.leaseId)]); }

async function chatGptLock(identity, id) {
  const directory = chatStoreJoin(identity.directory, '.locks');
  await chatStoreMkdir(directory, { recursive: true, mode: 0o700 });

  if (!(await chatStoreLstat(directory)).isDirectory()) throw new Error('Invalid ChatGPT storage lock directory.');
  const handle = await chatStoreOpen(chatStoreJoin(directory, `${chatGptId(id)}.lock`), chatStoreConstants.O_CREAT | chatStoreConstants.O_RDWR | chatStoreConstants.O_NOFOLLOW, 0o600);

  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid ChatGPT storage lock file.');

    const code = await new Promise((resolve, reject) => {
      const child = chatStoreSpawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', handle.fd], timeout: 5000, killSignal: 'SIGKILL',
      });

      child.once('error', reject);
      child.once('close', resolve);
    });

    if (code === 0) return handle;

    if (code !== 75) throw new Error('Could not acquire the shared ChatGPT storage lock. Check that flock is available on this host.');
  } catch (error) { await handle.close(); throw error; }

  await handle.close();
}

export async function chatGptLeaseOperation(key, run) {
  const previous = chatGptLeaseOperations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(run);
  chatGptLeaseOperations.set(key, operation);

  try { return await operation; }
  finally { if (chatGptLeaseOperations.get(key) === operation) chatGptLeaseOperations.delete(key); }
}

export async function chatGptExpireLease(key) {
  const lease = chatGptLeases.get(key);

  if (!lease || chatGptLeaseLive(key, lease)) return;
  clearTimeout(lease.timer);
  await lease.lock?.close();
  chatGptLeases.delete(key);
}

function chatGptRenewLease(key, lease) {
  lease.expires = Date.now() + 30000;
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => {
    void chatGptLeaseOperation(key, () => chatGptExpireLease(key)).catch(() => undefined);
  }, 30001);
  lease.timer.unref();
}

async function chatGptSharedLease(identity, key, id) {
  await chatGptExpireLease(key);
  const lease = chatGptLeases.get(key);

  if (!lease || lease.lock) return lease;
  lease.lock = await chatGptLock(identity, id);

  if (lease.lock) return lease;
  clearTimeout(lease.timer);
  chatGptLeases.delete(key);
}

function chatGptLeaseOwned(lease, owner) { return lease.owner === owner && !lease.released; }

function chatGptLeaseRenewable(lease, owner, action) { return lease?.owner === owner && (!lease.released || action === 'claim'); }

export async function chatGptOwnership(identity, request, action = 'read') {
  const key = chatGptKey(identity, request.chatId);
  const owner = chatGptLeaseOwner(request);

  return chatGptLeaseOperation(key, async () => {
    let lease = await chatGptSharedLease(identity, key, request.chatId);

    if (action === 'release' && lease?.owner === owner) {
      lease.expires = 0; lease.released = true;
      await chatGptExpireLease(key);
      lease = chatGptLeases.get(key);
    } else if (chatGptLeaseRenewable(lease, owner, action)) { lease.released = false; chatGptRenewLease(key, lease); }

    if (lease) return { owned: chatGptLeaseOwned(lease, owner), available: false };
    const lock = await chatGptLock(identity, request.chatId);

    if (!lock) return { owned: false, available: false };

    if (action !== 'claim') { await lock.close();

    return { owned: false, available: true }; }

    lease = { owner, lock, busy: 0, expires: 0 };
    chatGptLeases.set(key, lease);
    chatGptRenewLease(key, lease);

    return { owned: true, available: false };
  });
}

export async function chatGptReserveLease(identity, request, recovery = false) {
  const key = chatGptKey(identity, request.chatId);
  const owner = chatGptLeaseOwner(request);

  return chatGptLeaseOperation(key, async () => {
    let lease = await chatGptSharedLease(identity, key, request.chatId);

    if (!lease && recovery) {
      const lock = await chatGptLock(identity, request.chatId);

      if (!lock) return;
      lease = { lock, busy: 0, expires: 0 };
      chatGptLeases.set(key, lease);
    } else if (lease?.owner !== owner || lease.released) return;

    if (!lease) return;
    lease.busy++;

    return lease;
  });
}

export async function chatGptFinishLease(identity, id, lease) {
  const key = chatGptKey(identity, id);

  await chatGptLeaseOperation(key, async () => {
    lease.busy--;
    await chatGptExpireLease(key);
  });
}

export async function chatGptOwnedOperation(identity, request, run) {
  const lease = await chatGptReserveLease(identity, request);

  if (!lease) throw new Error('This client does not hold the ChatGPT chat’s editing lease.');

  try { return { ...await run(lease), ownership: await chatGptOwnership(identity, request) }; }
  finally { await chatGptFinishLease(identity, request.chatId, lease); }
}

export function chatGptId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Invalid chat ID.');

  return value;
}

function chatGptFile(identity, id) { return chatStoreJoin(identity.directory, `${chatGptId(id)}.json`); }

export function chatGptKey(identity, id) { return `${identity.key}:${chatGptId(id)}`; }

function chatGptRevision(data) { return data === null ? null : chatStoreHash('sha256').update(data).digest('hex'); }

export async function chatGptStoredData(identity, id) {
  return chatGptDatabaseData(chatGptDatabase(identity.directory), id);
}

export async function chatGptStoredChat(identity, id) {
  const data = await chatGptStoredData(identity, id);

  if (data === null) {
    const error = new Error('This chat is unavailable for the selected account.');
    error.code = 'CHATGPT_CHAT_UNAVAILABLE';

    throw error;
  }

  return chatGptDecodeRecord(id, data);
}

export function chatGptRecordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function chatGptRecordString(value) {
  return typeof value === 'string';
}

export function chatGptRecordId(value) { return chatGptRecordString(value) && /^[a-zA-Z0-9-]{1,100}$/.test(value); }

function chatGptRecordMessage(message) {
  return chatGptRecordObject(message) && chatGptRecordId(message.id) && ['user', 'assistant'].includes(message.role) && chatGptRecordString(message.text);
}

function chatGptRecordSubmission(chat) {
  if (chat.submissionId !== undefined && !chatGptRecordId(chat.submissionId)) return false;

  if (chat.acceptedSubmissionIds !== undefined && (!Array.isArray(chat.acceptedSubmissionIds) || !chat.acceptedSubmissionIds.every(chatGptRecordId))) return false;

  return chat.interrupted === undefined || chat.interrupted === true || chat.interrupted === false;
}

function chatGptRecordFields(chat) {
  const optionalStrings = ['thinkingEffort', 'versionId', 'contextSource', 'error', 'revision'];

  if (!optionalStrings.every(field => chat[field] === undefined || chatGptRecordString(chat[field]))) return false;

  if (chat.conversationId !== undefined && !chatGptRecordId(chat.conversationId)) return false;

  return chatGptRecordId(chat.parentMessageId) && chatGptRecordSubmission(chat);
}

export function chatGptValidRecord(chat) {
  if (!chatGptRecordObject(chat) || !chatGptRecordId(chat.id)) return false;

  if (!chatGptRecordString(chat.title) || !chatGptRecordString(chat.model)) return false;

  if (!Number.isFinite(chat.updatedAt) || !['idle', 'streaming', 'stopping', 'complete', 'stopped', 'error'].includes(chat.status)) return false;

  return Array.isArray(chat.messages) && chat.messages.every(chatGptRecordMessage) && chatGptRecordFields(chat);
}

export function chatGptRecordError(reason) {
  const error = new Error(reason);
  error.code = 'CHATGPT_RECORD_DAMAGED';

  return error;
}

export function chatGptDecodeRecord(id, data) {
  let chat;

  try { chat = JSON.parse(data); } catch { throw chatGptRecordError('The saved record contains invalid JSON'); }

  if (!chatGptValidRecord(chat)) throw chatGptRecordError('The saved record contains an invalid chat record');

  if (chat.id !== id) throw chatGptRecordError('The saved chat ID does not match its stored ID');

  chatGptRevisions.set(chat, { value: chatGptRevision(data) });

  return chat;
}

export function chatGptDamagedChat(identity, id, error) {
  const reason = error.code === 'CHATGPT_RECORD_DAMAGED' ? error.message : `The saved record could not be read (${error.code || 'storage error'})`;
  const path = chatStoreJoin(identity.directory, 'chats.sqlite');
  const message = `${reason}. The saved data is preserved at ${path}. Stop the daemons using this account before restoring a known-good backup, or start a new chat and check ChatGPT history.`;

  return { id, title: `Saved chat needs repair (${id.slice(0, 8)})`, model: 'auto', updatedAt: 0, status: 'error', messages: [], error: message,
    storageDiagnostic: { chatId: id, filename: 'chats.sqlite', path, message, preserved: true } };
}

function chatGptWriteConflict() {
  const error = new Error('This ChatGPT transcript changed since it was loaded. Reload the chat before editing.');
  error.code = 'CHATGPT_REVISION_CONFLICT';

  return error;
}

export async function chatGptSyncDirectory(directory) {
  const parent = await chatStoreOpen(directory, chatStoreConstants.O_RDONLY | chatStoreConstants.O_DIRECTORY | chatStoreConstants.O_NOFOLLOW);

  try { await parent.sync(); }
  finally { await parent.close(); }
}

async function chatGptPublish(identity, chat, lease, baseline, data) {
  const key = chatGptKey(identity, chat.id);

  if (!lease.lock || chatGptLeases.get(key) !== lease || !chatGptLeaseLive(key, lease)) throw chatGptWriteConflict();

  const database = chatGptDatabase(identity.directory);
  database.exec('BEGIN IMMEDIATE');

  try {
    if (chatGptRevision(chatGptDatabaseData(database, chat.id)) !== baseline.value) throw chatGptWriteConflict();
    database.prepare('INSERT INTO chat_records (chat_id, record_json) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET record_json=excluded.record_json').run(chat.id, data);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }

  baseline.value = chatGptRevision(data);
  chatGptSaveErrors.delete(key);
  chatGptChanged(identity.providerId, 'chats');
}

export async function chatGptSave(identity, chat, lease) {
  const path = chatGptFile(identity, chat.id);
  const baseline = chatGptRevisions.get(chat);

  if (!baseline) throw chatGptWriteConflict();

  if (!chatGptValidRecord(chat)) throw chatGptRecordError('Refusing to save an invalid ChatGPT record');
  const revision = chatStoreUuid();
  const data = JSON.stringify({ ...chat, revision });
  const previous = chatGptWrites.get(path) ?? Promise.resolve();

  const write = previous.catch(() => undefined).then(async () => {
    await chatGptPublish(identity, chat, lease, baseline, data);
    chat.revision = revision;
  });

  chatGptWrites.set(path, write);

  try { await write; }
  catch (error) { chatGptSaveErrors.set(chatGptKey(identity, chat.id), error.message); throw error; }
  finally { if (chatGptWrites.get(path) === write) chatGptWrites.delete(path); }
}

export async function chatGptLoad(identity, id) {
  const live = chatGptActive.get(chatGptKey(identity, id));

  if (live?.chat) return live.chat;

  return chatGptStoredChat(identity, id);
}

export function chatGptIdle() { return !chatGptActive.size && !chatGptStopping.size && !chatGptOperations.size && !chatGptWrites.size && !chatGptLeaseOperations.size && ![...chatGptLeases.values()].some(lease => lease.busy > 0); }

export function chatGptTicketSnapshot() {
  return {
    tickets: [...chatGptTickets].filter(([_id, ticket]) => ticket.expires > Date.now()),
    leases: [...chatGptLeases].flatMap(([id, lease]) => lease.owner && !lease.released && chatGptLeaseLive(id, lease) ? [[id, { owner: lease.owner }]] : []),
  };
}

export function chatGptRestore(snapshot) {
  const tickets = Array.isArray(snapshot) ? snapshot : snapshot.tickets;

  for (const [id, ticket] of tickets) if (ticket.expires > Date.now()) chatGptTickets.set(id, ticket);

  for (const [id, saved] of snapshot.leases ?? []) {
    if (chatGptLeases.has(id)) continue;
    const lease = { owner: saved.owner, busy: 0, expires: 0 };
    chatGptLeases.set(id, lease);
    chatGptRenewLease(id, lease);
  }
}

export async function chatGptList(identity) {
  const records = chatGptDatabase(identity.directory).prepare('SELECT chat_id FROM chat_records').all();
  const chats = await Promise.all(records.map(record => chatGptListRecord(identity, record.chat_id)));

  return chats.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function chatGptListRecord(identity, id) {
  if (!chatGptRecordId(id)) return chatGptDamagedChat(identity, id, chatGptRecordError('The stored chat ID is invalid'));

  try {
    const chat = await chatGptLoad(identity, id);

    return chatGptSummary(chat, chatGptStopping.has(chatGptKey(identity, chat.id)));
  } catch (error) {
    if (error.code === 'CHATGPT_CHAT_UNAVAILABLE') return;

    return chatGptDamagedChat(identity, id, error);
  }
}

function chatGptSummary(chat, stopping) {
  return { id: chat.id, title: chat.title, model: chat.model, updatedAt: chat.updatedAt, status: stopping ? 'stopping' : chat.status, contextSource: chat.contextSource };
}
