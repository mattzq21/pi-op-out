import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishedTrace } from '../trace-command-fixture.mjs';

const { home, count, cwd, contents } = JSON.parse(readFileSync(0, 'utf8'));
const cleanup = [];
try {
  const fixture = await publishedTrace({ after: action => cleanup.push(action) }, undefined, undefined, { home, folder: 'batch', cwd });
  const chats = [];
  for (let index = 0; index < count; index++) {
    const preview = `Chat ${index}`;
    const path = await fixture.publish(contents?.[index] ?? JSON.stringify({ type: 'message', id: randomUUID(), parentId: null,
      message: { role: 'user', content: preview, timestamp: 1000 },
    }) + '\n');
    const { id } = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
    chats.push({ id, path, preview });
  }
  process.stdout.write(JSON.stringify(chats));
} finally {
  for (const action of cleanup.reverse()) await action();
}
