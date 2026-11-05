import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as database from '../session-database/index.ts';
import { onMainThread } from '../session-database/index.ts';

// The ownership record of each active conversation: the client that owns it (null when none does), the daemon run
// that wrote it, and the client that owned it last.
const recordSchema = Type.Object({
  client: Type.Union([Type.String(), Type.Null()]), token: Type.String(), previousClient: Type.Optional(Type.String()),
}, { additionalProperties: false });

function key(sessionId: string): string { return createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40); }

function validKey(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid conversation ownership key');

  return value;
}

function checked(body) {
  if (!Check(recordSchema, JSON.parse(body))) throw new Error('Invalid conversation ownership record');

  return body;
}

function readRecord(root: string, recordKey: string): string | null {
  validKey(recordKey);
  const body = database.conversationOwnershipBody(root, recordKey);

  return body === undefined ? null : checked(body);
}

const writeRecord = onMainThread('conversation-storage.writeRecord', (root: string, recordKey: string, body: string): void => {
  validKey(recordKey);
  database.saveConversationOwnership(root, recordKey, checked(body));
});

const removeRecord = onMainThread('conversation-storage.removeRecord', (root: string, recordKey: string): void => {
  validKey(recordKey);
  database.removeConversationOwnership(root, recordKey);
});

// Removes the ownership record of sessionId.
function forget(root: string, sessionId: string): void { database.removeConversationOwnership(root, key(sessionId)); }

// The ownership record of the conversation sessionId, or null.
function read(root, sessionId) { return readRecord(root, key(sessionId)); }

function write(root, sessionId, body) { writeRecord(root, key(sessionId), body); }

export { key, readRecord, writeRecord, removeRecord, forget, read, write };
