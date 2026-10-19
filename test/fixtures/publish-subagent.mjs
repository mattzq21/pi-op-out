// Publishes a subagent chat of an existing chat the way the subagent tool does (session-broker/subagents.ts).
// Input on stdin: { home, parent: { id, path }, name }. Output: { id, path } of the subagent chat.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

const { home, parent, name } = JSON.parse(readFileSync(0, 'utf8'));
process.env.HOME = home; delete process.env.PIOP_STORAGE_DIRECTORY;
const directory = await mkdtemp(join(home, 'subagent-fixture-'));
try {
  const outfile = join(directory, 'session-file.mjs');
  await build({ entryPoints: ['daemon/resources/piop-storage/session-file.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['@earendil-works/*'], plugins: [storageSchemaImports()],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { writeSessionFile } = await import(pathToFileURL(outfile));
  const { reserve } = await import("../../daemon/resources/session-database.cjs");
  const id = reserve(join(home, ".piop"));
  const timestamp = new Date().toISOString();
  const path = join(dirname(parent.path), `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const cwd = JSON.parse(readFileSync(parent.path, 'utf8').split('\n')[0]).cwd;
  await writeSessionFile(path, [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'session_info', id: 'info', parentId: null, timestamp, name: 'Subagent: ' + name },
    { type: 'custom', id: 'parent', parentId: 'info', timestamp, customType: 'piop-subagent-parent', data: { version: 1, sessionId: id, hostId: 'local', parentSessionId: parent.id, parentHostId: 'local', parentSessionPath: parent.path, toolCallId: randomUUID(), task: 'help', depth: 1, taskPath: '/' + name, parentTaskPath: '' } },
  ], { dependencies: { workspace: { path: cwd, kind: 'existing' } } });
  process.stdout.write(JSON.stringify({ id, path }));
} finally { await rm(directory, { recursive: true, force: true }); }
