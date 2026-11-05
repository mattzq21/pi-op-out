import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { createHash } from 'node:crypto';
import * as database from './session-database.ts';
import { onMainThread } from './main-thread.ts';

interface ExternalTranscriptRow { record_id: string; record_json: string }

function list(root): ExternalTranscriptRow[] {
  return database.connection(root).prepare('SELECT record_id, record_json FROM external_transcripts ORDER BY record_id').all() as unknown as ExternalTranscriptRow[];
}

function transcript(row) {
  const record = JSON.parse(row.record_json);

  if (!Check(Type.Object({ path: Type.String() }), record) || !path.isAbsolute(record.path) || row.record_id !== createHash('sha256').update(record.path).digest('hex')) throw new Error('Invalid external transcript record');

  return record.path;
}

const remove = onMainThread('external-transcripts.remove', (root: string, row: ExternalTranscriptRow) => {
  database.connection(root).prepare('DELETE FROM external_transcripts WHERE record_id=? AND record_json=?').run(row.record_id, row.record_json);
});

export { list, transcript, remove };
