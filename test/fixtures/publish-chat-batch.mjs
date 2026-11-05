import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { reserveId, bind, transaction } from '../../daemon/resources/session-database.cjs';
import stateRecords from '../../daemon/resources/piop-storage/session-records.cjs';
import sessionNames from '../../daemon/resources/session-broker/session-names.cjs';

const { home, count, cwd, contents } = JSON.parse(readFileSync(0, 'utf8'));
const root = join(home, '.piop');
const directory = join(root, 'sessions', 'batch');
mkdirSync(directory, { recursive: true });
const chats = [];
const records = [];
transaction(root, 'IMMEDIATE', () => {
  for (let index = 0; index < count; index++) {
    const id = reserveId(root);
    const path = join(directory, `${id}.jsonl`);
    const preview = `Chat ${index}`;
    const body = contents?.[index] ?? JSON.stringify({ type: 'message', id: randomUUID(), parentId: null,
      message: { role: 'user', content: preview, timestamp: 1000 },
    }) + '\n';
    const entries = [{ type: 'session', version: 3, id, cwd: cwd ?? home }, ...body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))];
    writeFileSync(path, stateRecords.stored(entries).map(entry => JSON.stringify(entry)).join('\n') + '\n');
    bind(root, id, path);
    const captured = stateRecords.capture(entries);
    const name = entries.findLast(entry => entry.type === 'session_info')?.name;
    if (captured.length || name) records.push({ path, id, captured, name });
    chats.push({ id, path, preview });
  }
});
for (const { path, id, captured, name } of records) {
  stateRecords.seed(path, id, captured);
  if (name) sessionNames.nameSession(path, id, name);
}
process.stdout.write(JSON.stringify(chats));
