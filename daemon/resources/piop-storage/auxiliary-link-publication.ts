import * as stateRecords from './session-records.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as io from './session-publication-io.ts';
import * as SessionDatabase from '../session-database.ts';

// Publishes an auxiliary chat of a plugin, then adds to its parent a core link record and the plugin's own message.
// The link record lets the core find the chat from its parent, for example when it restores an archive.
const recordSchema = Type.Object({ kind: Type.String({ minLength: 1 }), sessionId: io.uuid, sessionPath: Type.String(), cwd: Type.String(), parentSessionId: io.uuid, hostId: Type.String(), publicationId: io.uuid });

const messageSchema = Type.Object({ customType: Type.String({ minLength: 1 }), content: Type.String() });

const linkSchema = Type.Object({ record: recordSchema, message: messageSchema, parentSessionPath: Type.String(), parentIdentity: Type.String() });

interface TranscriptEntry { type: string; id?: string; customType?: string; data?: any; details?: unknown }

const entrySchema = Type.Object({ type: Type.String(), id: Type.Optional(Type.String()) });

const appendSchema = Type.Object({ path: Type.String(), identity: Type.String(), bytes: Type.Integer({ minimum: 0 }), digest: Type.String(), text: Type.String() });

const markerSchema = Type.Object({ parentSessionId: io.uuid, sessionId: io.uuid, publicationId: io.uuid, hostId: Type.String() });

function entries(body): TranscriptEntry[] {
  if (!body.endsWith('\n')) throw new Error('The parent transcript has an incomplete record; publication retained');

  return body.split('\n').flatMap(line => line ? [JSON.parse(line)] : []);
}

function matchingRecord(value, record) {
  return Check(recordSchema, value) && value.sessionId === record.sessionId && value.parentSessionId === record.parentSessionId && value.publicationId === record.publicationId && value.hostId === record.hostId;
}

function publicationState(saved: TranscriptEntry[], record, message) {
  const metadata = saved.some(entry => Check(entrySchema, entry) && entry.type === 'custom' && entry.customType === stateRecords.AUXILIARY_LINK && matchingRecord(entry.data, record));

  const link = saved.some(entry => Check(entrySchema, entry) && entry.type === 'custom_message' && entry.customType === message.customType && matchingRecord(entry.details, record));

  return { metadata, link };
}

function parentMarker(body, sessionId, kind) {
  return entries(body).find(entry => Check(entrySchema, entry) && stateRecords.isAuxiliaryParent(entry) && entry.data.kind === kind && Check(markerSchema, entry.data) && entry.data.sessionId === sessionId);
}

function bindsParent(marker, parentId, nonce, hostId) {
  return Boolean(marker) && marker.data.parentSessionId === parentId && marker.data.publicationId === nonce && marker.data.hostId === hostId;
}

function prepare(root, option, header, nonce, body) {
  const value = { record: option.record, message: option.message, parentSessionPath: option.parentSessionPath, parentIdentity: '' };

  if (!Check(linkSchema, value) || value.record.publicationId !== nonce || value.record.sessionId !== header.id) throw new Error('Invalid auxiliary chat publication ownership');

  if (!io.inside(path.join(root, 'sessions'), value.parentSessionPath) || value.record.sessionPath !== option.target) throw new Error('Auxiliary chat publication is outside its original parent storage');
  const parent = io.header(value.parentSessionPath);

  if (!parent || parent.id !== value.record.parentSessionId) throw new Error('The original parent of the auxiliary chat changed before publication');
  const marker = parentMarker(body, header.id, value.record.kind);

  if (!bindsParent(marker, parent.id, nonce, value.record.hostId)) throw new Error('Auxiliary chat transcript does not bind its original parent and publication');

  return { ...value, parentIdentity: io.identity(value.parentSessionPath) };
}

function missingEntries(saved, record, message) {
  const state = publicationState(saved, record, message);

  const result: Array<Record<string, unknown>> = [];

  let parentId = saved.findLast(entry => Check(entrySchema, entry) && entry.type !== 'session' && entry.id)?.id ?? null;

  const append = entry => { const next = { ...entry, id: randomUUID(), parentId, timestamp: new Date().toISOString() }; result.push(next); parentId = next.id; };

  if (!state.metadata) append({ type: 'custom', customType: stateRecords.AUXILIARY_LINK, data: record });

  if (!state.link) append({ type: 'custom_message', customType: message.customType, content: message.content, display: true, details: record });

  return result;
}

function savedJournal(journal) { SessionDatabase.savePublication(journal.root, journal.id, journal); }

function finishAppend(journal, file) {
  const plan = journal.parentRepair;

  if (!plan) return;

  if (!Check(appendSchema, plan)) throw new Error('Auxiliary chat parent repair plan is invalid; retained');
  const current = io.read(file);

  const tail = current.bytes.subarray(plan.bytes);

  const desired = Buffer.from(plan.text);

  const same = file === plan.path && io.identity(file) === plan.identity && io.hash(current.bytes.subarray(0, plan.bytes)) === plan.digest;

  if (same && tail.length < desired.length && desired.subarray(0, tail.length).equals(tail)) appendRemaining(file, current, plan, desired.subarray(tail.length));
  else if (!same || !tail.subarray(0, desired.length).equals(desired)) entries(current.body);
  journal.parentRepair = undefined;
  savedJournal(journal);
}

function appendRemaining(file, snapshot, plan, remaining) {
  if (io.read(file).fingerprint !== snapshot.fingerprint) throw new Error('Original parent of the auxiliary chat changed during recovery');
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);

  try {
    if (io.identity(file) !== plan.identity || io.fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== snapshot.fingerprint) throw new Error('Original parent of the auxiliary chat was replaced during recovery');
    let written = 0;

    while (written < remaining.length) written += fs.writeSync(descriptor, remaining, written, remaining.length - written, snapshot.bytes.length + written);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  io.sync(path.dirname(file));
}

function parentLocation(journal) {
  return io.locate(journal.root, journal.link.record.parentSessionId);
}

function currentRecord(journal) {
  const child = io.locate(journal.root, journal.sessionId, journal.id);

  if (!child) throw new Error('The auxiliary chat transcript is unavailable; pending publication retained');

  return { ...journal.link.record, sessionPath: child.path, cwd: child.header.cwd };
}

function acknowledge(journal) {
  const parent = parentLocation(journal);

  if (!parent) return false;
  const saved = stateRecords.merge(parent.path, entries(io.read(parent.path).body));

  const state = publicationState(saved, currentRecord(journal), journal.link.message);

  if (!state.metadata || !state.link) return false;
  io.sync(parent.path);
  io.sync(path.dirname(parent.path));

  return true;
}

// The locks of the parent conversation, as the daemon's conversation ownership takes them. A parent that a client holds is
// not changed here; its runtime saves the link.
function parentLocks(journal) {
  const key = io.hash(journal.link.record.parentSessionId.toLowerCase()).slice(0, 40);
  const control = io.claim('conversation:' + key);

  if (control === null) return null;
  const mutation = io.claim('conversation-mutation:' + key);

  if (mutation !== null) return [mutation, control];
  control();

  return null;
}

function reattachLocked(journal) {
  const parent = parentLocation(journal);

  if (!parent) return false;
  finishAppend(journal, parent.path);
  const snapshot = io.read(parent.path);

  const record = currentRecord(journal);

  const saved = stateRecords.merge(parent.path, entries(snapshot.body));
  const missing = missingEntries(saved, record, journal.link.message);
  stateRecords.save(parent.path, [...saved, ...missing]);

  if (missing.length) {
    const text = stateRecords.stored(missing).map(entry => JSON.stringify(entry)).join('\n') + '\n';
    journal.parentRepair = { path: parent.path, identity: io.identity(parent.path), bytes: snapshot.bytes.length, digest: io.hash(snapshot.bytes), text };
    savedJournal(journal);
    appendRemaining(parent.path, snapshot, journal.parentRepair, Buffer.from(text));
    finishAppend(journal, parent.path);
  }

  return acknowledge(journal);
}

function reattach(journal) {
  if (!Check(linkSchema, journal.link)) return false;
  const locks = parentLocks(journal);

  if (!locks) return false;

  try { return reattachLocked(journal); }
  finally { for (const release of locks) release(); }
}

export { recordSchema, linkSchema, prepare, acknowledge, reattach, currentRecord };
