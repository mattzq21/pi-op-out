import fs from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import * as database from './session-database.ts';
import { onMainThread } from './main-thread.ts';

function fingerprint(file) {
  const info = fs.lstatSync(file, { bigint: true });

  if (!info.isFile()) throw new Error('Storage report transcript is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function saved(db, file, stamp) {
  const row = db.prepare('SELECT body FROM storage_transcript_summaries WHERE session_path=? AND fingerprint=?').get(file, stamp);

  if (!row) return;

  try {
    const stored = deserialize(row.body);

    if (stored?.version === 2) return stored.value;
  } catch {}
}

const save = onMainThread('storage-transcript-cache.save', (root: string, file: string, stamp: string, value: unknown) => {
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    if (fingerprint(file) === stamp) db.prepare('INSERT INTO storage_transcript_summaries VALUES (?, ?, ?) ON CONFLICT(session_path) DO UPDATE SET fingerprint=excluded.fingerprint, body=excluded.body')
      .run(file, stamp, serialize({ version: 2, value }));
  });
});

async function read(root, db, file, inspect) {
  const stamp = fingerprint(file);
  const previous = saved(db, file, stamp);

  if (previous && fingerprint(file) === stamp) return previous;
  const value = await inspect();

  if (fingerprint(file) !== stamp) throw new Error('Transcript changed while preparing the storage report');
  save(root, file, stamp, value);

  return value;
}

async function withCache(root, operation) {
  const db = database.connection(root);

  return operation((file, inspect) => read(root, db, file, inspect), db);
}

export { withCache };
