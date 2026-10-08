import { open as chatStoreOpen, readdir as chatStoreReadDir, readFile as chatStoreRead, rename as chatStoreRename, rm as chatStoreRemove } from 'node:fs/promises';
import { join as chatStoreJoin } from 'node:path';
import { createHash as chatStoreHash, randomUUID as chatStoreUuid } from 'node:crypto';
import { spawn as chatStoreSpawn } from 'node:child_process';

export const chatGptWrites = new Map();

export const chatGptLeases = new Map();

export const chatGptLeaseOperations = new Map();

export const chatGptRevisions = new WeakMap();

export const chatGptSaveErrors = new Map();

function chatGptLeaseBusy(key, lease) { return lease.busy > 0 || chatGptActive.has(key) || chatGptStopping.has(key); }

function chatGptLeaseLive(key, lease) { return Boolean(lease && (lease.expires > Date.now() || chatGptLeaseBusy(key, lease))); }

function chatGptLeaseOwner(request) { return JSON.stringify([request.clientId, chatGptId(request.leaseId)]); }

async function chatGptLock(identity, id) {
  const handle = await chatStoreOpen(`${chatGptFile(identity, id)}.lock`, 'a+', 0o600);

  try {
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

export async function chatGptOwnership(identity, request, action = 'read') {
  const key = chatGptKey(identity, request.chatId);
  const owner = chatGptLeaseOwner(request);

  return chatGptLeaseOperation(key, async () => {
    let lease = await chatGptSharedLease(identity, key, request.chatId);

    if (action === 'release' && lease?.owner === owner) {
      lease.expires = 0;
      await chatGptExpireLease(key);
      lease = chatGptLeases.get(key);
    } else if (lease?.owner === owner) chatGptRenewLease(key, lease);

    if (lease) return { owned: lease.owner === owner, available: false };
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
    } else if (lease?.owner !== owner) return;

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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate dynamic ChatGPT wire values at the protocol boundary.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Invalid chat ID.');

  return value;
}

function chatGptFile(identity, id) { return chatStoreJoin(identity.directory, `${chatGptId(id)}.json`); }

export function chatGptKey(identity, id) { return `${identity.key}:${chatGptId(id)}`; }

function chatGptRevision(data) { return data === null ? null : chatStoreHash('sha256').update(data).digest('hex'); }

export async function chatGptStoredData(identity, id) {
  try { return await chatStoreRead(chatGptFile(identity, id), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate persisted ChatGPT records and remote catalogs before reading fields.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function chatGptRecordString(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate persisted ChatGPT records and remote catalogs before using strings.
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

  try { chat = JSON.parse(data); } catch { throw chatGptRecordError('The saved file contains invalid JSON'); }

  if (!chatGptValidRecord(chat)) throw chatGptRecordError('The saved file contains an invalid chat record');

  if (chat.id !== id) throw chatGptRecordError('The saved chat ID does not match its filename');

  chatGptRevisions.set(chat, { value: chatGptRevision(data) });

  return chat;
}

export function chatGptDamagedChat(identity, id, error) {
  const reason = error.code === 'CHATGPT_RECORD_DAMAGED' ? error.message : `The saved file could not be read (${error.code || 'storage error'})`;
  const path = chatStoreJoin(identity.directory, `${id}.json`);
  const message = `${reason}. The file is preserved at ${path}. Stop the daemons using this account before restoring a known-good backup, or start a new chat and check ChatGPT history.`;

  return { id, title: `Saved chat needs repair (${id.slice(0, 8)})`, model: 'auto', updatedAt: 0, status: 'error', messages: [], error: message,
    storageDiagnostic: { chatId: id, filename: `${id}.json`, path, message, preserved: true } };
}

function chatGptWriteConflict() {
  const error = new Error('This ChatGPT transcript changed since it was loaded. Reload the chat before editing.');
  error.code = 'CHATGPT_REVISION_CONFLICT';

  return error;
}

async function chatGptDurableTemporary(path, data) {
  const file = await chatStoreOpen(path, 'wx', 0o600);

  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
}

async function chatGptSyncDirectory(directory) {
  const parent = await chatStoreOpen(directory, 'r');

  try { await parent.sync(); }
  finally { await parent.close(); }
}

async function chatGptPublish(identity, chat, lease, baseline, data) {
  const key = chatGptKey(identity, chat.id);

  if (!lease.lock || chatGptLeases.get(key) !== lease || !chatGptLeaseLive(key, lease)) throw chatGptWriteConflict();

  if (chatGptRevision(await chatGptStoredData(identity, chat.id)) !== baseline.value) throw chatGptWriteConflict();
  const path = chatGptFile(identity, chat.id);
  const temporary = `${path}.${chatStoreUuid()}.tmp`;

  try {
    await chatGptDurableTemporary(temporary, data);
    await chatStoreRename(temporary, path);
    baseline.value = chatGptRevision(data);
    await chatGptSyncDirectory(identity.directory);
    chatGptSaveErrors.delete(key);
    chatGptChanged(identity.providerId, 'chats');
  } finally { await chatStoreRemove(temporary, { force: true }); }
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
    leases: [...chatGptLeases].flatMap(([id, lease]) => lease.owner && chatGptLeaseLive(id, lease) ? [[id, { owner: lease.owner }]] : []),
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
  const files = (await chatStoreReadDir(identity.directory)).filter(name => name.endsWith('.json'));
  const chats = await Promise.all(files.map(name => chatGptListRecord(identity, name.slice(0, -5))));

  return chats.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function chatGptListRecord(identity, id) {
  if (!chatGptRecordId(id)) return chatGptDamagedChat(identity, id, chatGptRecordError('The saved filename is not a valid chat ID'));

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
