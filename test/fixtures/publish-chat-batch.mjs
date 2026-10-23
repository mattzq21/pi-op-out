import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { open, reserveId, bind } from '../../daemon/resources/session-database.cjs';
import stateRecords from '../../daemon/resources/piop-storage/session-records.cjs';

const { home, count, cwd, contents } = JSON.parse(readFileSync(0, 'utf8'));
const root = join(home, '.piop');
const directory = join(root, 'sessions', 'batch');
mkdirSync(directory, { recursive: true });
const db = open(root);
const chats = [];
const records = [];
try {
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < count; index++) {
    const id = reserveId(db);
    const path = join(directory, `${id}.jsonl`);
    const preview = `Chat ${index}`;
    const body = contents?.[index] ?? JSON.stringify({ type: 'message', id: randomUUID(), parentId: null,
      message: { role: 'user', content: preview, timestamp: 1000 },
    }) + '\n';
    const entries = [{ type: 'session', version: 3, id, cwd: cwd ?? home }, ...body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))];
    writeFileSync(path, stateRecords.stored(entries).map(entry => JSON.stringify(entry)).join('\n') + '\n');
    bind(db, id, path);
    const captured = stateRecords.capture(entries);
    if (captured.length) records.push({ path, id, captured });
    chats.push({ id, path, preview });
  }
  db.exec('COMMIT');
} catch (error) {
  if (db.isTransaction) db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
for (const { path, id, captured } of records) stateRecords.seed(path, id, captured);
process.stdout.write(JSON.stringify(chats));
