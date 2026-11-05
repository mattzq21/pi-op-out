import fs from 'node:fs';
import path from 'node:path';
import * as database from './session-database.ts';
import { validSessionHeader } from './session-header.ts';

function prepare(target) {
  const directory = target.root;

  if (!fs.existsSync(directory)) return;
  const root = fs.realpathSync(directory);
  const file = target.path || (target.id && database.lookup(path.dirname(root), target.id));

  if (!file || !fs.existsSync(file)) return;
  const source = fs.realpathSync(file);

  if (path.dirname(source) !== root || !source.endsWith('.jsonl')) return;

  return inspect(root, source, target.id);
}

function inspect(directory, file, expected) {
  let entries;

  try { entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { return; }

  const header = entries[0];

  if (!validSessionHeader(header) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(header.id)) return;

  if (header.id === '00000000-0000-4000-8000-000000000001' || (expected && header.id !== expected)) return;

  if (entries.some(entry => entry.type === 'message')) return;
  const root = path.dirname(directory);

  if (database.hasQueuedInput(root, header.id)) return;

  return { root, id: header.id, target: { root: directory, path: file, area: 'sessions' } };
}

export { prepare };
