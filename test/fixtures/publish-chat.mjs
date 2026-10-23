import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { publishedTrace } from '../trace-command-fixture.mjs';

async function publish({ home, content, folder, cwd, controlsBundle }) {
  const cleanup = [];
  try {
    const chat = await publishedTrace({ after: action => cleanup.push(action) }, undefined, content, { home, folder, cwd, controlsBundle });
    return { id: chat.id, path: chat.path };
  } finally {
    for (const action of cleanup.reverse()) await action();
  }
}

if (process.argv.includes('--stream')) {
  for await (const line of createInterface({ input: process.stdin })) {
    process.stdout.write(JSON.stringify(await publish(JSON.parse(line))) + '\n');
  }
} else process.stdout.write(JSON.stringify(await publish(JSON.parse(readFileSync(0, 'utf8')))));
