import { readFileSync } from 'node:fs';
import { publishedTrace } from '../trace-command-fixture.mjs';

const { home, content, folder, cwd, controlsBundle } = JSON.parse(readFileSync(0, 'utf8'));
const cleanup = [];
try {
  const chat = await publishedTrace({ after: action => cleanup.push(action) }, undefined, content, { home, folder, cwd, controlsBundle });
  process.stdout.write(JSON.stringify({ id: chat.id, path: chat.path }));
} finally {
  for (const action of cleanup.reverse()) await action();
}
