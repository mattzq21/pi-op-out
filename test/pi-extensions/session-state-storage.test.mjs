import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import database from '../../daemon/resources/session-database.cjs';
import sessionNames from '../../daemon/resources/session-broker/session-names.cjs';
import newChats from '../../daemon/resources/piop-storage/new-chats.cjs';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';
import { testPi } from '../pi-install.mjs';
import { localStorageChannel } from '../local-storage-channel.mjs';

const { root: sdk } = await testPi();

let installSessionStorage, localTranscriptWrites;

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
  if (!installSessionStorage) await build({ entryPoints: ['test/session-storage-entry.mjs'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  if (!installSessionStorage) ({ installSessionStorage, localTranscriptWrites } = await import(pathToFileURL(bundle)));
  const { SessionManager } = await import(pathToFileURL(join(sdk, 'dist/core/session-manager.js')));
  installSessionStorage(SessionManager, localTranscriptWrites());
  const id = database.reserve(root);
  const file = join(root, 'sessions', `2026-10-19T00-00-00-000Z_${id}.jsonl`);
  const db = database.connection(root);
  database.bind(db, id, file);
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-19T00:00:00.000Z', cwd: home }) + '\n');
  return { home, root, id, file, SessionManager, manager: SessionManager.open(file), physical: () => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('Pi sessions refuse names, and the session broker keeps names of at most 50 characters', async t => {
  const f = await fixture(t);
  const body = readFileSync(f.file, 'utf8');
  assert.throws(() => f.manager.appendSessionInfo('Pi name'), /session broker owns chat names/);
  assert.equal(readFileSync(f.file, 'utf8'), body);
  for (const name of ['x'.repeat(50), 'x'.repeat(51), '😀'.repeat(51)]) {
    assert.equal(sessionNames.renameSession(f.root, f.id, name), Array.from(name).slice(0, 50).join(''));
    assert.equal(sessionNames.sessionName(f.file, f.id), Array.from(name).slice(0, 50).join(''));
  }
  assert.throws(() => sessionNames.renameSession(f.root, f.id, ' \t '), /name can't be empty/);
  assert.equal(f.SessionManager.open(f.file).getSessionName(), undefined);
});

test('a name line in a saved transcript stays out of Pi', async t => {
  const f = await fixture(t);
  const user = { type: 'message', id: 'user', parentId: 'name', timestamp: '2026-10-19T00:00:01.000Z', message: { role: 'user', content: 'Start', timestamp: 1 } };
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + JSON.stringify({ type: 'session_info', id: 'name', parentId: null, timestamp: '2026-10-19T00:00:00.000Z', name: 'Old name' }) + '\n' + JSON.stringify(user) + '\n');
  const opened = f.SessionManager.open(f.file);
  assert.equal(opened.getSessionName(), undefined);
  assert.deepEqual(opened.getEntries().map(entry => [entry.type, entry.parentId]), [['message', null]]);
});

test('skill MCP requirements keep their current removal across navigation and restart', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('piop-skill-mcp', [{ file: '/skill/SKILL.md', servers: [{ alias: 'app', name: 'skill_app', config: { command: 'server' } }] }]);
  const earlier = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  f.manager.appendMessage({ role: 'user', content: 'Later', timestamp: 2 });
  f.manager.appendCustomEntry('piop-skill-mcp', [{ file: '/skill/SKILL.md', servers: [] }]);
  f.manager.branch(earlier);
  const reopened = f.SessionManager.open(f.file);
  const entries = reopened.getBranch().filter(entry => entry.customType === 'piop-skill-mcp');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].data, [{ file: '/skill/SKILL.md', servers: [] }]);
});

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
  const db = database.connection(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records').get().n, 0);
});

test('failed SQL state writes do not advance the branch or change the transcript', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const before = readFileSync(f.file, 'utf8');
  const leaf = f.manager.getLeafId();
  const db = database.connection(f.root);
  db.exec("CREATE TRIGGER reject_state BEFORE INSERT ON session_extension_state BEGIN SELECT RAISE(ABORT, 'Write failed'); END");
  assert.throws(() => f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true }), /Write failed/);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), leaf);
});

test('SQL state follows archive and restore and is removed with the session', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('pi-define-agents-state', { active: 'Builder' });
  sessionNames.renameSession(f.root, f.id, 'Named chat');
  const selected = f.manager.appendMessage({ role: 'user', content: 'First', timestamp: 1 });
  f.manager.appendMessage({ role: 'user', content: 'Second', timestamp: 2 });
  f.manager.branch(selected);
  const saved = f.manager.getEntries();
  const db = database.connection(f.root);
  db.prepare('UPDATE sessions SET archived=1 WHERE session_id=?').run(f.id);
  assert.deepEqual(f.SessionManager.open(f.file).getEntries(), saved);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), selected);
  assert.equal(sessionNames.sessionName(f.file, f.id), 'Named chat');
  db.prepare('UPDATE sessions SET archived=0 WHERE session_id=?').run(f.id);
  assert.deepEqual(f.SessionManager.open(f.file).getEntries(), saved);
  db.prepare('DELETE FROM sessions WHERE session_id=?').run(f.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_branch_selection').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_names').get().n, 0);
});

test('a new chat copies current settings once, independent of the selected message', async t => {
  const f = await fixture(t);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  const user = f.manager.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  const left = f.manager.appendMessage({ role: 'user', content: 'Left', timestamp: 2 });
  f.manager.branch(user);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: false });
  f.manager.appendMessage({ role: 'user', content: 'Right', timestamp: 3 });
  const id = database.reserve(f.root);
  const target = join(f.root, 'sessions', `2026-10-19T01-00-00-000Z_${id}.jsonl`);
  newChats.create(f.root, { path: target, entries: [{ ...f.manager.getHeader(), id, parentSession: f.file }, ...f.manager.getBranch(left)] });
  assert.equal(readFileSync(target, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(entry => entry.type === 'custom'), false);
  const fork = f.SessionManager.open(target);
  assert.deepEqual(fork.getBranch().filter(entry => entry.customType === 'piop-fast-mode-state').map(entry => entry.data), [{ enabled: false }]);
  f.manager.appendCustomEntry('piop-fast-mode-state', { enabled: true });
  assert.equal(f.SessionManager.open(target).getBranch().find(entry => entry.customType === 'piop-fast-mode-state').data.enabled, false);
  const db = database.connection(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(id).n, 1);
});


test('a rename shows in the chat list, keeps the transcript, and a failed write keeps the old name', async t => {
  const f = await fixture(t);
  const first = f.manager.appendMessage({ role: 'user', content: 'First', timestamp: 1 });
  const body = readFileSync(f.file, 'utf8');
  const bundle = join(f.home, 'lists.mjs');
  await build({ entryPoints: ['daemon/resources/sdk-session-list.mjs'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports(), localStorageChannel()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  (await import(pathToFileURL(bundle))).installSessionLists(f.SessionManager);
  sessionNames.renameSession(f.root, f.id, 'First name');
  assert.equal((await f.SessionManager.listAll())[0].name, 'First name');
  sessionNames.renameSession(f.root, f.id, 'Current name');
  assert.equal((await f.SessionManager.listAll())[0].name, 'Current name');
  assert.equal(f.manager.getLeafId(), first);
  assert.equal(readFileSync(f.file, 'utf8'), body);
  const db = database.connection(f.root);
  db.exec("CREATE TRIGGER reject_name BEFORE UPDATE ON session_names BEGIN SELECT RAISE(ABORT, 'name write failed'); END;");
  assert.throws(() => sessionNames.renameSession(f.root, f.id, 'Lost name'), /name write failed/);
  assert.equal(sessionNames.sessionName(f.file, f.id), 'Current name');
  db.exec('DROP TRIGGER reject_name');
});

test('model and thinking selections stay current across messages, navigation and restart', async t => {
  const f = await fixture(t);
  const { getBranchSelection } = await import(pathToFileURL(join(sdk, 'dist/core/virtual-models.js')));
  f.manager.appendModelChange('provider', 'old-model');
  f.manager.appendThinkingLevelChange('low');
  const user = f.manager.appendMessage({ role: 'user', content: 'Question', timestamp: 1 });
  f.manager.appendMessage({ role: 'assistant', provider: 'provider', model: 'old-model', content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop', timestamp: 2 });
  const body = readFileSync(f.file, 'utf8');
  const leaf = f.manager.getLeafId();
  f.manager.appendModelChange('provider', 'new-model');
  f.manager.appendThinkingLevelChange('high');
  assert.equal(readFileSync(f.file, 'utf8'), body);
  assert.equal(f.manager.getLeafId(), leaf);
  for (const manager of [f.manager, f.SessionManager.open(f.file)]) {
    for (const id of [leaf, user]) {
      manager.branch(id);
      assert.deepEqual(manager.buildSessionContext().model, { provider: 'provider', modelId: 'new-model' });
      assert.equal(manager.buildSessionContext().thinkingLevel, 'high');
      assert.deepEqual(getBranchSelection(manager.getBranch(), () => undefined), { provider: 'provider', modelId: 'new-model' });
    }
  }
  const db = database.connection(f.root);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(f.id).n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records WHERE session_id=?').get(f.id).n, 0);
  db.exec("CREATE TRIGGER reject_selection BEFORE UPDATE ON session_extension_state BEGIN SELECT RAISE(ABORT, 'selection write failed'); END;");
  assert.throws(() => f.manager.appendModelChange('provider', 'lost-model'), /selection write failed/);
  assert.throws(() => f.manager.appendThinkingLevelChange('low'), /selection write failed/);
  assert.deepEqual(f.manager.buildSessionContext().model, { provider: 'provider', modelId: 'new-model' });
  assert.equal(f.manager.buildSessionContext().thinkingLevel, 'high');
});

test('current model settings preserve the history used for compaction', async t => {
  const f = await fixture(t);
  const { prepareCompaction } = await import(pathToFileURL(join(sdk, 'dist/core/compaction/compaction.js')));
  f.manager.appendModelChange('provider', 'model');
  f.manager.appendThinkingLevelChange('high');
  f.manager.appendMessage({ role: 'user', content: 'Remember the otter.', timestamp: 1 });
  f.manager.appendMessage({ role: 'user', content: 'Later task '.repeat(100), timestamp: 2 });
  const leaf = f.manager.getLeafId();
  for (const manager of [f.manager, f.SessionManager.open(f.file)]) {
    const prepared = prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 100, keepRecentTokens: 10 });
    assert.ok(prepared);
    assert.ok(prepared.messagesToSummarize.some(message => message.content === 'Remember the otter.'));
    assert.equal(manager.getLeafId(), leaf);
  }
});

test('the chat preview and reopened session follow a branch choice without a transcript write', async t => {
  const f = await fixture(t);
  const bundle = join(f.home, 'index.mjs');
  await build({ stdin: { contents: 'export { indexSessions } from "./daemon/resources/index-sessions.cjs";', resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { indexSessions } = await import(pathToFileURL(bundle));
  const summary = async () => {
    const result = await indexSessions({ paths: [f.file] });
    assert.deepEqual(result.warnings, []);
    return result.summaries[0];
  };
  f.manager.appendMessage({ role: 'user', content: 'First question', timestamp: 1 });
  const answer = f.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First answer' }], timestamp: 2 });
  f.manager.appendMessage({ role: 'user', content: 'Detour', timestamp: 3 });
  const detour = f.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Detour answer' }], timestamp: 4 });
  assert.equal((await summary()).preview, 'Detour answer');
  const body = readFileSync(f.file, 'utf8');
  f.manager.branch(answer);
  assert.equal(readFileSync(f.file, 'utf8'), body);
  assert.equal((await summary()).preview, 'First answer');
  assert.equal((await summary()).messageCount, 2);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), answer);
  const db = database.connection(f.root);
  db.exec("CREATE TRIGGER reject_branch BEFORE UPDATE ON session_branch_selection BEGIN SELECT RAISE(ABORT, 'branch write failed'); END;");
  assert.throws(() => f.manager.branch(detour), /branch write failed/);
  assert.equal(f.manager.getLeafId(), answer);
  db.exec('DROP TRIGGER reject_branch');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_branch_selection WHERE session_id=?').get(f.id).n, 1);
  f.manager.branch(detour);
  assert.equal((await summary()).preview, 'Detour answer');
  f.manager.resetLeaf();
  assert.equal((await summary()).messageCount, 0);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), null);
  const next = f.manager.appendMessage({ role: 'user', content: 'New start', timestamp: 5 });
  assert.equal((await summary()).preview, 'New start');
  assert.equal((await summary()).messageCount, 1);
  assert.equal(f.SessionManager.open(f.file).getLeafId(), next);
});

test('recovered queued-input chats keep their names in SQL when reopened', async t => {
  const f = await fixture(t);
  const { createTranscript } = await import('../../daemon/resources/piop-storage/recovery.cjs');
  const id = database.reserve(f.root);
  const file = join(f.root, 'sessions', `recovered_${id}.jsonl`);
  const db = database.connection(f.root);
  database.bind(db, id, file);
  db.exec("CREATE TRIGGER reject_recovered_name BEFORE INSERT ON session_names BEGIN SELECT RAISE(ABORT, 'recovery name write failed'); END;");
  assert.throws(() => createTranscript(file, id, f.home, 'Important queued request'), /recovery name write failed/);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(f.root, 'sessions', '.queued-input-recovery-' + id)), false);
  db.exec('DROP TRIGGER reject_recovered_name');
  assert.equal(createTranscript(file, id, f.home, 'Important queued request'), true);
  assert.equal(sessionNames.sessionName(file, id), 'Recovered queued input: Important queued request');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).some(entry => entry.type === 'session_info'), false);
  sessionNames.renameSession(f.root, id, 'Renamed recovered chat');
  assert.equal(createTranscript(file, id, f.home, 'Another request'), false);
  assert.equal(sessionNames.sessionName(file, id), 'Renamed recovered chat');
});

test('a skill prompt that names its skill gives the session name one skill reference', async t => {
  const f = await fixture(t);
  const bundle = join(f.home, 'index.mjs');
  await build({ stdin: { contents: 'export { indexSessions } from "./daemon/resources/index-sessions.cjs";', resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [storageSchemaImports()], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { indexSessions } = await import(pathToFileURL(bundle));
  const skill = '<skill name="statechart" location="/skills/statechart/SKILL.md">\nReferences are relative to /skills/statechart.\n\nbody\n</skill>';
  f.manager.appendMessage({ role: 'user', content: `${skill}\n\n$statechart draw the simplest example.`, timestamp: 1 });
  assert.equal((await indexSessions({ paths: [f.file] })).summaries[0].name, '$statechart draw the simplest example.');
});
