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

let installSessionStorage;

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
  if (!installSessionStorage) await build({ entryPoints: ['daemon/resources/piop-storage/session-storage.mjs'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  installSessionStorage ??= (await import(pathToFileURL(bundle))).installSessionStorage;
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

test('settings keep only their current value across navigation and restart', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const user = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  const left = f.manager.appendMessage({ role: 'user', content: 'Left', timestamp: 2 });
  f.manager.branch(user);
  assert.equal(f.manager.getBranch().find(entry => entry.customType === 'piop-fast-mode-state').data.enabled, true);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  assert.equal(f.manager.getLeafId(), user);
  f.manager.appendMessage({ role: 'user', content: 'Right', timestamp: 3 });
  assert.equal(f.physical().some(entry => entry.type === 'custom'), false);
  const reopened = f.SessionManager.open(f.file);
  for (const id of [user, left]) {
    const states = reopened.getBranch(id).filter(entry => entry.customType === 'piop-fast-mode-state');
    assert.equal(states.length, 1);
    assert.equal(states[0].data.enabled, false);
  }
  assert.deepEqual(reopened.getEntries(), f.manager.getEntries());
  const db = database.open(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records').get().n, 0);
  db.close();
});

test('failed SQL state writes do not advance the branch or change the transcript', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('pi-desktop-pause-state', { isPaused: false });
  const before = readFileSync(f.file, 'utf8');
  const leaf = f.manager.getLeafId();
  const db = database.open(f.root);
  db.exec("CREATE TRIGGER reject_state BEFORE INSERT ON session_extension_state BEGIN SELECT RAISE(ABORT, 'Write failed'); END");
  db.close();
  assert.throws(() => f.manager.appendCustomEntry('pi-desktop-pause-state', { isPaused: true }), /Write failed/);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), leaf);
});

test('SQL state follows archive and restore and is removed with the session', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('pi-define-agents-state', { active: 'Builder' });
  f.manager.appendSessionInfo('Named chat');
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
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state').get().n, 0);
  db.close();
});

test('fork publication copies current settings once, independent of the selected message', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const user = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  const left = f.manager.appendMessage({ role: 'user', content: 'Left', timestamp: 2 });
  f.manager.appendSessionInfo('Current title');
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
  const fork = f.SessionManager.open(target);
  assert.equal(fork.getSessionName(), 'Current title');
  assert.deepEqual(fork.getBranch().filter(entry => entry.customType === 'piop-fast-mode-state').map(entry => entry.data), [{ enabled: false }]);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  assert.equal(f.SessionManager.open(target).getBranch().find(entry => entry.customType === 'piop-fast-mode-state').data.enabled, false);
  const db = database.open(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(id).n, 2);
  db.close();
});


test('chat names keep one SQL value without writing transcript history', async t => {
  const f = await fixture(t);
  const first = f.manager.appendMessage({ role: 'user', content: 'First', timestamp: 1 });
  const body = readFileSync(f.file, 'utf8');
  const bundle = join(f.home, 'lists.mjs');
  await build({ entryPoints: ['daemon/resources/sdk-session-list.mjs'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  (await import(pathToFileURL(bundle))).installSessionLists(f.SessionManager);
  f.manager.appendSessionInfo('First name');
  assert.equal((await f.SessionManager.listAll())[0].name, 'First name');
  f.manager.appendSessionInfo('Current name');
  assert.equal(f.manager.getSessionName(), 'Current name');
  assert.equal((await f.SessionManager.listAll())[0].name, 'Current name');
  assert.equal(f.manager.getLeafId(), first);
  assert.equal(readFileSync(f.file, 'utf8'), body);
  assert.equal(f.physical().some(entry => entry.type === 'session_info'), false);
  f.manager.branch(first);
  assert.equal(f.manager.getSessionName(), 'Current name');
  assert.equal(f.SessionManager.open(f.file).getSessionName(), 'Current name');
  const db = database.open(f.root);
  try {
    const rows = db.prepare("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-session-name'").all(f.id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].entry_json).name, 'Current name');
    db.exec("CREATE TRIGGER reject_name BEFORE UPDATE ON session_extension_state BEGIN SELECT RAISE(ABORT, 'name write failed'); END;");
    assert.throws(() => f.manager.appendSessionInfo('Lost name'), /name write failed/);
    assert.equal(f.manager.getSessionName(), 'Current name');
    assert.equal(readFileSync(f.file, 'utf8'), body);
    db.exec('DROP TRIGGER reject_name');
    f.manager.appendSessionInfo('');
    assert.equal(f.SessionManager.open(f.file).getSessionName(), undefined);
  } finally { db.close(); }
});
