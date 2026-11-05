import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { home, cwd, folder } = JSON.parse(readFileSync(0, 'utf8'));
process.env.HOME = home; delete process.env.PIOP_STORAGE_DIRECTORY;
{
  const { create } = await import('../../daemon/resources/piop-storage/new-chats.cjs');
  const { reserve } = await import("../../daemon/resources/session-database.cjs");
  const sessions = join(home, '.piop', 'sessions', folder);
  await mkdir(sessions, { recursive: true });
  const publish = async (name, parent) => {
    const id = reserve(join(home, '.piop'));
    const timestamp = new Date().toISOString();
    const path = join(sessions, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
    const entries = parent ? [
      { type: 'custom', id: 'parent', parentId: null, timestamp, customType: 'piop-auxiliary-parent', data: { kind: 'subagent', version: 1, sessionId: id, hostId: 'local', parentSessionId: parent.id, parentHostId: 'local', toolCallId: randomUUID(), task: 'help' } },
    ] : [{ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Saved chat', timestamp: 1 } }];
    create(join(home, '.piop'), { path, entries: [{ type: 'session', version: 3, id, timestamp, cwd }, ...entries], ...parent ? { name: 'Subagent: ' + name } : {} });
    return { id, path };
  };
  const root = await publish();
  const child = await publish('researcher', root);
  const grandchild = await publish('reader', child);
  const other = await publish();
  process.stdout.write(JSON.stringify({ root, child, grandchild, other }));
}
