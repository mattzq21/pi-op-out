import fs from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import * as database from './session-database.ts';
import { onMainThread } from './main-thread.ts';

function fingerprint(file: string): string {
  const info = fs.lstatSync(file, { bigint: true });

  if (!info.isFile()) throw new Error('Storage report transcript is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function saved(root, file, stamp) {
  const body = database.storageTranscriptSummary(root, file, stamp);

  if (!body) return;

  try {
    const stored = deserialize(body);

    if (stored?.version === 2) return stored.value;
  } catch {}
}

const save = onMainThread('storage-transcript-cache.save', (root: string, file: string, stamp: string, value: unknown) => {
  database.transaction(root, 'IMMEDIATE', () => {
    if (fingerprint(file) === stamp) database.saveStorageTranscriptSummary(root, file, stamp, serialize({ version: 2, value }));
  });
});

async function read(root, file, inspect) {
  const stamp = fingerprint(file);
  const previous = saved(root, file, stamp);

  if (previous && fingerprint(file) === stamp) return previous;
  const value = await inspect();

  if (fingerprint(file) !== stamp) throw new Error('Transcript changed while preparing the storage report');
  save(root, file, stamp, value);

  return value;
}

async function withCache(root, operation) {
  return operation((file, inspect) => read(root, file, inspect));
}

export { withCache };
