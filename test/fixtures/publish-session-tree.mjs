import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

const { home, cwd, folder } = JSON.parse(readFileSync(0, 'utf8'));
process.env.HOME = home; delete process.env.PIOP_STORAGE_DIRECTORY;
const directory = await mkdtemp(join(home, 'subagent-fixture-'));
try {
  const outfile = join(directory, 'session-file.mjs');
  await build({ entryPoints: ['daemon/resources/piop-storage/session-file.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['@earendil-works/*'], plugins: [storageSchemaImports()],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { writeSessionFile } = await import(pathToFileURL(outfile));
  const { reserve } = await import("../../daemon/resources/session-database.cjs");
  const sessions = join(home, '.piop', 'sessions', folder);
  await mkdir(sessions, { recursive: true });
  const publish = async (name, parent, depth = 0) => {
    const id = reserve(join(home, '.piop'));
    const timestamp = new Date().toISOString();
    const path = join(sessions, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
    const entries = parent ? [
      { type: 'session_info', id: 'info', parentId: null, timestamp, name: 'Subagent: ' + name },
      { type: 'custom', id: 'parent', parentId: 'info', timestamp, customType: 'piop-subagent-parent', data: { version: 1, sessionId: id, hostId: 'local', parentSessionId: parent.id, parentHostId: 'local', parentSessionPath: parent.path, toolCallId: randomUUID(), task: 'help', depth, taskPath: '/' + name, parentTaskPath: '' } },
    ] : [{ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Saved chat', timestamp: 1 } }];
    await writeSessionFile(path, [{ type: 'session', version: 3, id, timestamp, cwd }, ...entries], { dependencies: { workspace: { path: cwd, kind: 'existing' } } });
    return { id, path };
  };
  const root = await publish();
  const child = await publish('researcher', root, 1);
  const grandchild = await publish('reader', child, 2);
  const other = await publish();
  process.stdout.write(JSON.stringify({ root, child, grandchild, other }));
} finally { await rm(directory, { recursive: true, force: true }); }
