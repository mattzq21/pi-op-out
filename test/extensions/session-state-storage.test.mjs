import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import database from '../../daemon/resources/session-database.cjs';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

let sdk = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(sdk, 'package.json')) || JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).name !== '@earendil-works/pi-coding-agent') {
  const parent = dirname(sdk);
  if (parent === sdk) throw new Error('Pi SDK not found');
  sdk = parent;
}

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'piop-session-state-'));
  const root = join(home, '.piop');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const previousHome = process.env.HOME, previousStorage = process.env.PIOP_STORAGE_DIRECTORY;
  process.env.HOME = home;
  delete process.env.PIOP_STORAGE_DIRECTORY;
  t.after(() => {
    process.env.HOME = previousHome;
    if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
    rmSync(home, { recursive: true, force: true });
  });
  const bundle = join(home, 'storage.mjs');
  await build({ entryPoints: ['daemon/resources/piop-storage/session-storage.mjs'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { installSessionStorage } = await import(pathToFileURL(bundle));
  const { SessionManager } = await import(pathToFileURL(join(sdk, 'dist/core/session-manager.js')));
  installSessionStorage(SessionManager);
  const id = database.reserve(root);
  const file = join(root, 'sessions', `2026-10-19T00-00-00-000Z_${id}.jsonl`);
  const db = database.open(root);
  database.bind(db, id, file);
  db.close();
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-19T00:00:00.000Z', cwd: home }) + '\n');
  return { home, root, id, file, SessionManager, manager: SessionManager.open(file), physical: () => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('extension state stays in SQL and restores the exact branches after restart', async t => {
  const f = await fixture(t);
  const initial = f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const user = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  const left = f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  f.manager.appendMessage({ role: 'user', content: 'Left', timestamp: 2 });
  f.manager.branch(user);
  const right = f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  f.manager.appendMessage({ role: 'user', content: 'Right', timestamp: 3 });
  assert.equal(f.physical().some(entry => entry.type === 'custom'), false);
  const reopened = f.SessionManager.open(f.file);
  const stateIds = id => reopened.getBranch(id).filter(entry => entry.type === 'custom').map(entry => entry.id);
  assert.deepEqual(stateIds(left), [initial, left]);
  assert.deepEqual(stateIds(right), [initial, right]);
  assert.deepEqual(reopened.getEntries(), f.manager.getEntries());
});

test('failed SQL state writes do not advance the branch or change the transcript', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('pi-desktop-pause-state', { isPaused: false });
  const before = readFileSync(f.file, 'utf8');
  const leaf = f.manager.getLeafId();
  const db = database.open(f.root);
  db.exec("CREATE TRIGGER reject_state BEFORE INSERT ON session_extension_records BEGIN SELECT RAISE(ABORT, 'Write failed'); END");
  db.close();
  assert.throws(() => f.manager.appendCustomEntry('pi-desktop-pause-state', { isPaused: true }), /Write failed/);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), leaf);
});

test('SQL state follows archive and restore and is removed with the session', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('pi-define-agents-state', { active: 'Builder' });
  const saved = f.manager.getEntries();
  mkdirSync(join(f.root, 'archived'));
  const archived = join(f.root, 'archived', 'chat.jsonl');
  renameSync(f.file, archived);
  database.movePaths(f.root, [{ source: f.file, destination: archived }]);
  assert.deepEqual(f.SessionManager.open(archived).getEntries(), saved);
  renameSync(archived, f.file);
  database.movePaths(f.root, [{ source: archived, destination: f.file }]);
  assert.deepEqual(f.SessionManager.open(f.file).getEntries(), saved);
  const db = database.open(f.root);
  db.prepare('DELETE FROM sessions WHERE session_id=?').run(f.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records').get().n, 0);
  db.close();
});

test('fork publication copies only the selected branch state into SQL', async t => {
  const f = await fixture(t);
  const initial = f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const user = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  const left = f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  f.manager.appendMessage({ role: 'user', content: 'Left', timestamp: 2 });
  f.manager.branch(user);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  f.manager.appendMessage({ role: 'user', content: 'Right', timestamp: 3 });
  const bundle = join(f.home, 'publish.mjs');
  await build({ entryPoints: ['daemon/resources/piop-storage/session-file.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { writeSessionFile } = await import(pathToFileURL(bundle));
  const id = database.reserve(f.root);
  const target = join(f.root, 'sessions', `2026-10-19T01-00-00-000Z_${id}.jsonl`);
  await writeSessionFile(target, [{ ...f.manager.getHeader(), id, parentSession: f.file }, ...f.manager.getBranch(left)]);
  assert.equal(readFileSync(target, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(entry => entry.type === 'custom'), false);
  assert.deepEqual(f.SessionManager.open(target).getBranch().filter(entry => entry.type === 'custom').map(entry => entry.id), [initial, left]);
  const db = database.open(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records WHERE session_id=?').get(id).n, 2);
  db.close();
});
