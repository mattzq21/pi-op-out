import * as stateRecords from './piop-storage/session-records.ts';
import fs from 'node:fs';
import * as database from './session-database.ts';
import { onMainThread } from './main-thread.ts';

// The last saved summary of each transcript that this process saved, by path.
const cache = new Map<string, { root: string; record: any[]; stamp: string }>();

function fingerprint(info) {
  if (!info.isFile()) throw new Error('Transcript reference source is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function relevant(entry, root) {
  return entry?.goalAssets !== undefined || JSON.stringify(entry)?.includes(JSON.stringify(root).slice(1, -1));
}

function summarize(entries, root) {
  return JSON.parse(JSON.stringify([entries[0], ...entries.slice(1).filter(entry => relevant(entry, root))]));
}

function save(root, file, stamp, entries) {
  database.saveTranscriptReference(root, file, entries[0]?.id?.constructor === String ? entries[0].id.toLowerCase() : null, stamp, JSON.stringify(entries));
}

function appendSaved(root, file, previous, stamp, entry) {
  if (!previous) return false;

  return database.appendTranscriptReference(root, file, previous, stamp, entry ? JSON.stringify(entry) : undefined);
}

function messageDetails(entry) {
  if (entry?.type === 'custom_message') return entry.details;

  return entry?.type === 'message' ? entry.message?.details : undefined;
}

function delivery(entry, sessionId): [string, string] | undefined {
  const details = messageDetails(entry);

  if (!details || details.mailboxSessionId !== sessionId) return;

  if (![details.notificationId, details.mailboxFingerprint].every(value => value?.constructor === String)) return;

  return [details.notificationId, details.mailboxFingerprint];
}

function receiptFingerprint(stamp) {
  const parts = stamp.split(':');

  return `${parts[3]}:${parts[2]}`;
}

function publishReceipts(root, file, stamp, previous, id, entries, entry?) {
  const fingerprint = receiptFingerprint(stamp);
  const addition = delivery(entry, id);

  if (previous && database.appendMailboxReceipts(root, id, file, receiptFingerprint(previous), fingerprint, addition ? JSON.stringify(addition) : undefined)) return;
  const saved = new Map();

  for (const current of entries()) {
    const receipt = delivery(current, id);

    if (receipt) saved.set(...receipt);
  }

  database.saveMailboxReceipts(root, id, file, fingerprint, JSON.stringify([...saved]));
}

function savedEntries(file) {
  return stateRecords.merge(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
}

// Saves the summary of the whole transcript, which has just been saved.
const publish = onMainThread('transcript-references.publish', (root: string, file: string, entries: any[]) => {
  root = fs.realpathSync(root);
  const record = summarize(entries, root);
  const stamp = fingerprint(fs.lstatSync(file, { bigint: true }));
  database.transaction(root, 'IMMEDIATE', () => {
    save(root, file, stamp, record);
    publishReceipts(root, file, stamp, undefined, entries[0]?.id, () => entries);
  });

  cache.set(file, { root, record, stamp });
});

// Adds one entry that has just been saved. `before` is the transcript file as it was before that.
const append = onMainThread('transcript-references.append', (root: string, file: string, entry: any, before: fs.BigIntStats) => {
  root = fs.realpathSync(root);
  const previous = cache.get(file);
  const stamp = fingerprint(fs.lstatSync(file, { bigint: true }));

  if (previous?.root !== root || previous.stamp !== fingerprint(before)) {
    const entries = savedEntries(file);
    const record = summarize(entries, root);

    database.transaction(root, 'IMMEDIATE', () => {
      save(root, file, stamp, record);
      publishReceipts(root, file, stamp, undefined, entries[0]?.id, () => entries);
    });
    cache.set(file, { root, record, stamp });

    return;
  }
  const addition = relevant(entry, root) ? JSON.parse(JSON.stringify(entry)) : undefined;
  const record = addition ? [...previous.record, addition] : previous.record;
  const id = previous.record[0]?.id;

  database.transaction(root, 'IMMEDIATE', () => {
    if (!appendSaved(root, file, previous.stamp, stamp, addition)) save(root, file, stamp, record);
    publishReceipts(root, file, stamp, previous.stamp, id, () => savedEntries(file), entry);
  });

  cache.set(file, { root, record, stamp });
});

function read(root, file) {
  root = fs.realpathSync(root);

  if (fs.realpathSync(file) !== file) throw new Error('Transcript reference source has ambiguous ownership');
  const before = fingerprint(fs.lstatSync(file, { bigint: true }));
  const saved = database.transcriptReferenceEntries(root, file, before);

  if (saved !== undefined) {
    if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed while reading saved references');

    return stateRecords.merge(file, JSON.parse(saved));
  }

  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let entries;

  try {
    if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
    entries = fs.readFileSync(descriptor, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
  const summary = summarize(stateRecords.merge(file, entries), root);
  saveSummary(root, file, before, summary);

  return summary;
}

const saveSummary = onMainThread('transcript-references.saveSummary', save);

export { read, publish, append };
