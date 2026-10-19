const stateRecords = require('./session-records.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-publication-io.cjs');

const recordSchema = Type.Object({ sessionId: io.uuid, sessionPath: Type.String(), cwd: Type.String(), parentSessionId: io.uuid, hostId: Type.String(), publicationId: io.uuid });

const reviewSchema = Type.Object({ record: recordSchema, parentSessionPath: Type.String(), parentIdentity: Type.String() });

const entrySchema = Type.Object({ type: Type.String(), id: Type.Optional(Type.String()) });

const appendSchema = Type.Object({ path: Type.String(), identity: Type.String(), bytes: Type.Integer({ minimum: 0 }), digest: Type.String(), text: Type.String() });

const markerSchema = Type.Object({ parentSessionId: io.uuid, sessionId: io.uuid, publicationId: io.uuid, hostId: Type.String() });

function entries(body) {
  if (!body.endsWith('\n')) throw new Error('The parent transcript has an incomplete record; publication retained');

  return body.split('\n').flatMap(line => line ? [JSON.parse(line)] : []);
}

function matchingRecord(value, record) {
  return Check(recordSchema, value) && value.sessionId === record.sessionId && value.parentSessionId === record.parentSessionId && value.publicationId === record.publicationId && value.hostId === record.hostId;
}

function publicationState(saved, record) {
  const metadata = saved.some(entry => Check(entrySchema, entry) && entry.type === 'custom' && entry.customType === 'piop-review' && matchingRecord(entry.data, record));

  const link = saved.some(entry => Check(entrySchema, entry) && entry.type === 'custom_message' && entry.customType === 'piop-review-link' && matchingRecord(entry.details, record));

  return { metadata, link };
}

function parentMarker(body, sessionId) {
  return entries(body).find(entry => Check(entrySchema, entry) && entry.type === 'custom' && entry.customType === 'piop-review-parent' && Check(markerSchema, entry.data) && entry.data.sessionId === sessionId);
}

function bindsParent(marker, parentId, nonce, hostId) {
  return Boolean(marker) && marker.data.parentSessionId === parentId && marker.data.publicationId === nonce && marker.data.hostId === hostId;
}

function prepare(root, option, header, nonce, body) {
  const value = { ...option, parentIdentity: '' };

  if (!Check(reviewSchema, value) || value.record.publicationId !== nonce || value.record.sessionId !== header.id) throw new Error('Invalid review publication ownership');

  if (!io.inside(path.join(root, 'sessions'), value.parentSessionPath) || value.record.sessionPath !== option.target) throw new Error('Review publication is outside its original parent storage');
  const parent = io.header(value.parentSessionPath);

  if (!parent || parent.id !== value.record.parentSessionId) throw new Error('The original review parent changed before publication');
  const marker = parentMarker(body, header.id);

  if (!bindsParent(marker, parent.id, nonce, value.record.hostId)) throw new Error('Review transcript does not bind its original parent and publication');

  return { record: value.record, parentSessionPath: value.parentSessionPath, parentIdentity: io.identity(value.parentSessionPath) };
}

function missingEntries(saved, record) {
  const state = publicationState(saved, record);

  const result = [];

  let parentId = saved.findLast(entry => Check(entrySchema, entry) && entry.type !== 'session' && entry.id)?.id ?? null;

  const append = entry => { const next = { ...entry, id: randomUUID(), parentId, timestamp: new Date().toISOString() }; result.push(next); parentId = next.id; };

  if (!state.metadata) append({ type: 'custom', customType: 'piop-review', data: record });

  if (!state.link) append({ type: 'custom_message', customType: 'piop-review-link', content: 'Code review', display: true, details: record });

  return result;
}

function savedJournal(journal) { require('../session-database.cjs').savePublication(journal.root, journal.id, journal); }

function finishAppend(journal, file) {
  const plan = journal.parentRepair;

  if (!plan) return;

  if (!Check(appendSchema, plan)) throw new Error('Review parent repair plan is invalid; retained');
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
  if (io.read(file).fingerprint !== snapshot.fingerprint) throw new Error('Original review parent changed during recovery');
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);

  try {
    if (io.identity(file) !== plan.identity || io.fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== snapshot.fingerprint) throw new Error('Original review parent was replaced during recovery');
    let written = 0;

    while (written < remaining.length) written += fs.writeSync(descriptor, remaining, written, remaining.length - written, snapshot.bytes.length + written);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  io.sync(path.dirname(file));
}

function parentLocation(journal) {
  return io.locate(journal.root, journal.review.record.parentSessionId);
}

function currentRecord(journal) {
  const child = io.locate(journal.root, journal.sessionId, journal.id);

  if (!child) throw new Error('The review transcript is unavailable; pending publication retained');

  return { ...journal.review.record, sessionPath: child.path, cwd: child.header.cwd };
}

function acknowledge(journal) {
  const parent = parentLocation(journal);

  if (!parent) return false;
  const saved = stateRecords.merge(parent.path, entries(io.read(parent.path).body));

  const state = publicationState(saved, currentRecord(journal));

  if (!state.metadata || !state.link) return false;
  io.sync(parent.path);
  io.sync(path.dirname(parent.path));

  return true;
}

function parentLocks(journal) {
  const key = io.hash(journal.review.record.parentSessionId.toLowerCase()).slice(0, 40);

  const claims = path.join(journal.root, 'session-claims');

  const ownership = path.join(journal.root, 'conversation-ownership');
  io.mkdir(claims);
  io.mkdir(ownership);
  const worker = io.claim(path.join(claims, `id-${key}.lock`));

  if (worker === null) return null;

  try {
    const control = io.claim(path.join(ownership, `${key}.lock`));

    if (control !== null) return [worker, control];
  } catch (error) { fs.closeSync(worker); throw error; }

  fs.closeSync(worker);

  return null;
}

function reattachLocked(journal) {
  const parent = parentLocation(journal);

  if (!parent) return false;
  finishAppend(journal, parent.path);
  const snapshot = io.read(parent.path);

  const record = currentRecord(journal);

  const saved = stateRecords.merge(parent.path, entries(snapshot.body));
  const missing = missingEntries(saved, record);
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
  if (!Check(reviewSchema, journal.review) || !io.writerDead(journal.writer)) return false;
  const locks = parentLocks(journal);

  if (!locks) return false;

  try { return reattachLocked(journal); }
  finally { for (const descriptor of locks) fs.closeSync(descriptor); }
}

module.exports = { recordSchema, reviewSchema, prepare, acknowledge, reattach, currentRecord };
