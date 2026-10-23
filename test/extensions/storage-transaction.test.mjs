import { historyContract } from '../../daemon/resources/piop-storage/goal-assets.cjs';
import conversationStorage from '../../daemon/resources/conversation-storage.cjs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTraceControls } from '../trace-command-fixture.mjs';
import { goalCommand } from '../goal-command-fixture.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { chatPublisher } from '../chat-publisher-fixture.mjs';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after } from 'node:test';
import { storageSchemaImports } from '../../scripts/storage-schema-plugin.mjs';

const bun = process.env.PIOP_TEST_BUN || 'bun';
const maxCrashes = 200;
const bundleDirectory = mkdtempSync(join(tmpdir(), 'piop-storage-transaction-bundle-'));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const entry = join(bundleDirectory, 'storage-transaction.mjs');
const controlsBundle = join(bundleDirectory, 'controls.mjs');
await buildTraceControls(controlsBundle);

await build({
  stdin: { contents: `
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostOperation, runHostOperation, shutdownHostOperations } from './daemon/src/host_operations';
import { isHostOperationWorker, runHostOperationWorker } from './daemon/src/host_operation_worker';
if (isHostOperationWorker()) runHostOperationWorker();
else {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const root = request.root ?? dirname(request.targets[0].root);
  try {
    const result = await runHostOperation(hostOperation('storage-transaction', 'storage', 30000, value => value), request, { storageRoot: root });
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, state: error.state, error: error.message }));
    process.exitCode = 1;
  } finally { await shutdownHostOperations(); }
}
`, resolveDir: process.cwd(), sourcefile: 'storage-test-entry.ts', loader: 'ts' }, outfile: entry,
  bundle: true, platform: 'node', format: 'esm', target: 'esnext', external: ['bun', 'bun:*'], logLevel: 'silent',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __PIOP_BUILD_ID__: '"storage-test"', __PIOP_DEVELOPMENT__: 'false', __PIOP_PROJECT_DIR__: '""' },
  plugins: [storageSchemaImports(), { name: 'host-imports', setup(builder) {
    builder.onResolve({ filter: /^piop-agent-loader$/ }, () => ({ path: join(process.cwd(), 'extensions/piop-define-agents/daemon-loader.ts') }));
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: join(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    builder.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  } }],
});

const sessionId = '6f2c1d4e-8a9b-4c3d-9e1f-0a1b2c3d4e5f';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'piop-storage-transaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  const sessions = join(profile, 'sessions');
  mkdirSync(join(sessions, 'target.snapshots'), { recursive: true });
  const target = join(sessions, 'target.jsonl');
  writeFileSync(target, JSON.stringify({ type: 'session', id: sessionId, cwd: directory }) + '\n');
  writeFileSync(join(sessions, 'target.snapshots', 'one.json'), '{}');
  writeFileSync(join(sessions, 'other.jsonl'), JSON.stringify({ type: 'session', id: 'other', cwd: directory }) + '\n');

  return { profile, sessions, target };
}

function tree(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const file = join(directory, name);
    const relative = prefix + name;

    return lstatSync(file).isDirectory() ? [relative + '/', ...tree(file, relative + '/')] : [relative + '=' + readFileSync(file, 'utf8')];
  });
}

async function run(request, environment = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = execFile(bun, [entry], {
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
      env: { ...process.env, BUN_BE_BUN: '1', ...environment },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || (!error.signal && typeof error.code !== 'number'))) { reject(error); return; }
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, signal: error?.signal, stdout, stderr });
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(request));
  });
  const reply = result.stdout ? JSON.parse(result.stdout) : undefined;
  return { ...result, reply, outcome: reply && (reply.ok ? reply.result : { state: reply.state, error: reply.error }) };
}

function goalOwners(root, directory) {
  const db = new DatabaseSync(join(root, 'sessions.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT identity, record_json FROM goal_ownership WHERE directory=? ORDER BY identity').all(directory); }
  finally { db.close(); }
}

const deletion = fixture => ({ action: 'delete', targets: [{ path: fixture.target, area: 'sessions', root: fixture.sessions }], activeSessionIds: [] });

describe('storage transactions', { concurrency: 6 }, () => {
test('delete fully happens or fully rolls back after a crash at any write', async t => {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    assert.ok(crashAfter < maxCrashes, 'no committed run within ' + maxCrashes + ' crash points');
    const current = fixture(t);
    const before = tree(current.sessions);
    const after = before.filter(line => line.startsWith('other.jsonl'));
    const result = await run(deletion(current), { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      assert.equal(result.outcome.state, 'committed');
      assert.deepEqual(tree(current.sessions), after);
      const recovery = await run({ action: 'recover', root: current.profile });
      assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
      assert.deepEqual(tree(current.sessions), after);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = await run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
    const state = tree(current.sessions);
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + state.join(', '));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    const repeatedRecovery = await run({ action: 'recover', root: current.profile });
    assert.equal(repeatedRecovery.status, 0, repeatedRecovery.stdout + repeatedRecovery.stderr);
    assert.deepEqual(tree(current.sessions), state, 'repeated recovery must preserve the recovered files');
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected delete leaves storage unchanged', async t => {
  const current = fixture(t);
  const before = tree(current.sessions);
  const result = await run({ ...deletion(current), activeSessionIds: [sessionId] });

  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.equal(result.outcome.error, 'Deletion failed: Close the session before deleting it');
  assert.deepEqual(tree(current.sessions), before);
  const retry = await run(deletion(current));
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(retry.outcome.state, 'committed');
  assert.deepEqual(tree(current.sessions), before.filter(line => line.startsWith('other.jsonl')));
});

test('restore fully happens or fully rolls back after a crash at any write', async t => {
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const profile = join(home, '.piop');
  const outcomes = new Set();
  const content = JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep this restored chat' } }) + '\n';
  const publish = chatPublisher(t, { home, content, controlsBundle });
  const other = await publish();
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: other.path, terminalIds: [], clientId: 'restore-crash-test' });
  const initial = await daemon.invoke('storage_report');
  const otherPath = initial.hosts.find(host => host.hostId === 'local').archives.find(row => row.id === other.id).path;
  const otherContent = readFileSync(otherPath, 'utf8');


  for (let crashAfter = 0; ; crashAfter += 1) {
    assert.ok(crashAfter < maxCrashes, 'no committed run within ' + maxCrashes + ' crash points');
    const chat = await publish();
    const snapshots = chat.path.replace(/\.jsonl$/, '.snapshots');
    mkdirSync(snapshots);
    writeFileSync(join(snapshots, 'one.json'), '{}');
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'restore-crash-test' });
    const report = await daemon.invoke('storage_report');
    const archived = report.hosts.find(host => host.hostId === 'local').archives.find(row => row.id === chat.id).path;
    writeFileSync(chat.path, 'Destination is occupied');
    await assert.rejects(daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archived, clientId: 'restore-crash-test' }), /Restoration destination already exists/);
    rmSync(chat.path);
    const archivedSnapshots = archived.replace(/\.jsonl$/, '.snapshots');
    const original = readFileSync(archived, 'utf8');
    const observe = () => ({ active: existsSync(chat.path), archived: existsSync(archived), activeSnapshots: existsSync(snapshots), archivedSnapshots: existsSync(archivedSnapshots) });
    const before = { active: false, archived: true, activeSnapshots: false, archivedSnapshots: true };
    const after = { active: true, archived: false, activeSnapshots: true, archivedSnapshots: false };
    assert.deepEqual(observe(), before);
    const result = await run({ action: 'restore', paths: [archived], root: profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });
    if (result.status !== 0) assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    else {
      assert.equal(result.outcome.state, 'committed');
      assert.deepEqual(result.outcome.result.sessions, [{ path: home, sessionPath: chat.path, sessionId: chat.id, sourcePath: archived }]);
    }
    const recovered = await run({ action: 'recover', root: profile });
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    const state = observe();
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    assert.equal(readFileSync(state.active ? chat.path : archived, 'utf8'), original);
    assert.deepEqual(tree(state.active ? snapshots : archivedSnapshots), ['one.json={}']);
    const repeated = await run({ action: 'recover', root: profile });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.deepEqual(observe(), state);
    assert.equal(readFileSync(otherPath, 'utf8'), otherContent);
    if (result.status === 0) {
      assert.deepEqual(state, after);
      const receipt = await run({ action: 'result', path: archived, root: profile });
      assert.equal(receipt.status, 0, receipt.stdout + receipt.stderr);
      assert.deepEqual(receipt.outcome.result, result.outcome.result);
      break;
    }
    outcomes.add(state.active ? 'after' : 'before');
  }
  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected restore preserves the archive and the existing destination', async t => {
  const current = fixture(t);
  const archived = await run({ action: 'archive', paths: [current.target], root: current.profile });
  assert.equal(archived.status, 0, archived.stdout + archived.stderr);
  const path = archived.outcome.result.sessions[0].sessionPath;
  const content = readFileSync(path, 'utf8');
  writeFileSync(current.target, 'taken');
  const before = tree(current.sessions);
  const result = await run({ action: 'restore', paths: [path], root: current.profile });

  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.equal(result.outcome.error, 'Restore failed: Restoration destination already exists: ' + current.target);
  assert.deepEqual(tree(current.sessions), before);
  assert.equal(readFileSync(path, 'utf8'), content);
  assert.equal(readFileSync(path.replace(/\.jsonl$/, '.snapshots/one.json'), 'utf8'), '{}');
});

test('archive fully happens or fully rolls back after a crash at any write', async t => {
  const outcomes = new Set();
  const message = { type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep this message after recovery' } };
  const observe = current => ({
    sessions: tree(current.sessions),
    otherArchivedFiles: readdirSync(current.archived).filter(name => !name.endsWith('.jsonl') && !(name.endsWith('.snapshots') && existsSync(join(current.archived, name.replace(/\.snapshots$/, '.jsonl'))))),
    archives: readdirSync(current.archived).filter(name => name.endsWith('.jsonl')).sort().map(name => {
      const path = join(current.archived, name);
      const [header, ...entries] = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      return { id: header.id, cwd: header.cwd, entries, snapshots: tree(path.replace(/\.jsonl$/, '.snapshots')) };
    }),
  });

  for (let crashAfter = 0; ; crashAfter += 1) {
    assert.ok(crashAfter < maxCrashes, 'no committed run within ' + maxCrashes + ' crash points');
    const current = fixture(t);
    writeFileSync(current.target, readFileSync(current.target, 'utf8') + JSON.stringify(message) + '\n');
    current.archived = join(current.profile, 'archived');
    mkdirSync(current.archived);
    const before = observe(current);
    const after = {
      sessions: before.sessions.filter(line => line.startsWith('other.jsonl')),
      otherArchivedFiles: [],
      archives: [{ id: sessionId, cwd: dirname(current.profile), entries: [message], snapshots: ['one.json={}'] }],
    };
    const result = await run({ action: 'archive', paths: [current.target], root: current.profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      assert.equal(result.outcome.state, 'committed');
      assert.equal(result.outcome.result.sessions.length, 1);
      assert.equal(result.outcome.result.sessions[0].sessionId, sessionId);
      assert.equal(result.outcome.result.sessions[0].sourcePath, current.target);
      assert.deepEqual(observe(current), after);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = await run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
    const state = observe(current);
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    const repeated = await run({ action: 'recover', root: current.profile });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.deepEqual(observe(current), state);
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected archive preserves the source and the existing destination', async t => {
  const current = fixture(t);
  const source = readFileSync(current.target, 'utf8');
  const first = await run({ action: 'archive', paths: [current.target], root: current.profile });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const destination = first.outcome.result.sessions[0].sessionPath;
  const archived = readFileSync(destination, 'utf8');
  writeFileSync(current.target, source);
  mkdirSync(join(current.sessions, 'target.snapshots'));
  writeFileSync(join(current.sessions, 'target.snapshots', 'one.json'), '{}');
  const before = tree(current.sessions);

  const result = await run({ action: 'archive', paths: [current.target], root: current.profile });
  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.equal(result.outcome.error, 'Archive failed: Archive destination already exists: ' + destination);
  assert.deepEqual(tree(current.sessions), before);
  assert.equal(readFileSync(destination, 'utf8'), archived);
});

function goalTranscript(file, header, goal) {
  const message = { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Read ' + join(goal, 'goal-objective.md') } };
  const text = JSON.stringify(header) + '\n' + JSON.stringify(message) + '\n';
  writeFileSync(file, text);

  return text;
}

test('archive with goal folders fully happens or fully rolls back after a crash at any write', async t => {
  const prepareGoal = await goalCommand(t);
  const objective = 'Complete the requested work. '.repeat(160).trim();
  const outcomes = new Set();
  for (let crashAfter = 0; ; crashAfter++) {
    assert.ok(crashAfter < maxCrashes, 'archive never completed within the crash-point limit');
    const current = fixture(t);
    const prepared = await prepareGoal(current.target, objective);
    const goal = join(current.sessions, 'attachments', readdirSync(join(current.sessions, 'attachments')).find(name => name.startsWith('goal-')));
    assert.ok(prepared.message.includes(join(goal, 'goal-objective.md')));
    const ownersBeforeMove = goalOwners(current.profile, goal);
    const header = JSON.parse(readFileSync(current.target, 'utf8'));
    const source = goalTranscript(current.target, header, goal);
    const archived = join(current.profile, 'archived');
    mkdirSync(archived);
    const other = readFileSync(join(current.sessions, 'other.jsonl'), 'utf8');
    const result = await run({ action: 'archive', paths: [current.target], root: current.profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });
    if (result.status !== 0) assert.equal(result.stdout, '', result.stderr);
    else assert.equal(result.outcome.state, 'committed');
    const recover = await run({ action: 'recover', root: current.profile });
    assert.equal(recover.status, 0, recover.stdout + recover.stderr);
    const archivedFiles = readdirSync(archived).filter(name => name.endsWith('.jsonl'));
    const moved = !existsSync(current.target);
    assert.equal(archivedFiles.length, moved ? 1 : 0);
    const surviving = moved ? join(archived, archivedFiles[0]) : current.target;
    const entries = readFileSync(surviving, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries[0].id, sessionId);
    assert.equal(entries[0].cwd, header.cwd);
    assert.deepEqual(entries.slice(1), [{ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Read ' + join(goal, 'goal-objective.md') } }]);
    if (!moved) assert.equal(readFileSync(surviving, 'utf8'), source);
    assert.deepEqual(tree(surviving.replace(/\.jsonl$/, '.snapshots')), ['one.json={}']);
    assert.equal(readFileSync(join(goal, 'goal-objective.md'), 'utf8'), objective);
    assert.deepEqual(goalOwners(current.profile, goal), ownersBeforeMove, 'archive must not change attachment ownership');
    assert.equal(readFileSync(join(current.sessions, 'other.jsonl'), 'utf8'), other);
    const beforeRetry = { sessions: tree(current.sessions), archived: tree(archived), goal: tree(goal) };
    const repeated = await run({ action: 'recover', root: current.profile });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.deepEqual({ sessions: tree(current.sessions), archived: tree(archived), goal: tree(goal) }, beforeRetry);
    const deleted = await run({ action: 'delete', targets: [{ path: surviving, area: moved ? 'archived' : 'sessions', root: moved ? archived : current.sessions }], activeSessionIds: [] });
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.equal(existsSync(surviving), false);
    assert.equal(existsSync(goal), false, 'deleting the last chat must release its goal folder');
    assert.equal(readFileSync(join(current.sessions, 'other.jsonl'), 'utf8'), other);
    if (result.status === 0) { assert.equal(moved, true); break; }
    outcomes.add(moved ? 'after' : 'before');
  }
  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('archive that rejects a later attachment leaves all attachment ownership unchanged', async t => {
  const current = fixture(t);
  const prepareGoal = await goalCommand(t);
  const firstPrepared = await prepareGoal(current.target, 'Preserve the first objective. '.repeat(150).trim());
  const firstGoal = dirname(firstPrepared.message.match(/Read the goal objective file at (.+?) before continuing\./)[1]);
  goalTranscript(current.target, JSON.parse(readFileSync(current.target, 'utf8')), firstGoal);
  const second = join(current.sessions, 'second.jsonl');
  const secondHeader = { type: 'session', id: crypto.randomUUID(), cwd: current.profile };
  writeFileSync(second, JSON.stringify(secondHeader) + '\n');
  const secondPrepared = await prepareGoal(second, 'Preserve the second objective. '.repeat(150).trim());
  const secondGoal = dirname(secondPrepared.message.match(/Read the goal objective file at (.+?) before continuing\./)[1]);
  goalTranscript(second, secondHeader, secondGoal);
  const firstText = readFileSync(current.target, 'utf8');
  const secondText = readFileSync(second, 'utf8');
  const firstFiles = tree(firstGoal), secondFiles = tree(secondGoal);
  const displaced = secondGoal + '-displaced';
  renameSync(secondGoal, displaced);
  symlinkSync(displaced, secondGoal);
  const result = await run({ action: 'archive', paths: [current.target, second], root: current.profile });
  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.match(result.outcome.error, /goal/i);
  assert.equal(readFileSync(current.target, 'utf8'), firstText);
  assert.equal(readFileSync(second, 'utf8'), secondText);
  assert.deepEqual(tree(firstGoal), firstFiles);
  assert.deepEqual(tree(displaced), secondFiles);
  assert.deepEqual(tree(join(current.profile, 'archived')), []);
  rmSync(secondGoal);
  renameSync(displaced, secondGoal);
  const recovered = await run({ action: 'recover', root: current.profile });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  for (const [path, goal] of [[current.target, firstGoal], [second, secondGoal]]) {
    const deleted = await run({ action: 'delete', targets: [{ path, area: 'sessions', root: current.sessions }], activeSessionIds: [] });
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.equal(existsSync(goal), false, 'failed moves must not retain deleted goal files');
  }
});

test('restore with goal folders fully happens or fully rolls back after a crash at any write', async t => {
  const prepareGoal = await goalCommand(t);
  const objective = 'Restore this goal and its files. '.repeat(150).trim();
  const daemon = await daemonClient(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const profile = join(home, '.piop');
  const outcomes = new Set();
  const content = JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep this restored chat' } }) + '\n';
  const publish = chatPublisher(t, { home, content, controlsBundle });
  const other = await publish();
  await daemon.invoke('archive_session', { hostId: 'local', sessionPath: other.path, terminalIds: [], clientId: 'restore-crash-test' });
  const initial = await daemon.invoke('storage_report');
  const otherPath = initial.hosts.find(host => host.hostId === 'local').archives.find(row => row.id === other.id).path;
  const otherContent = readFileSync(otherPath, 'utf8');


  for (let crashAfter = 0; ; crashAfter += 1) {
    assert.ok(crashAfter < maxCrashes, 'no committed run within ' + maxCrashes + ' crash points');
    const chat = await publish();
    const prepared = await prepareGoal(chat.path, objective);
    const goalPath = prepared.message.match(/Read the goal objective file at (.+?) before continuing\./)?.[1];
    assert.ok(goalPath, 'prepared prompt must name the saved objective file');
    const goal = dirname(goalPath);
    const ownersBeforeMove = goalOwners(profile, goal);
    const header = JSON.parse(readFileSync(chat.path, 'utf8').split('\n')[0]);
    goalTranscript(chat.path, header, goal);
    const snapshots = chat.path.replace(/\.jsonl$/, '.snapshots');
    mkdirSync(snapshots);
    writeFileSync(join(snapshots, 'one.json'), '{}');
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'restore-crash-test' });
    const report = await daemon.invoke('storage_report');
    const archived = report.hosts.find(host => host.hostId === 'local').archives.find(row => row.id === chat.id).path;
    writeFileSync(chat.path, 'Destination is occupied');
    await assert.rejects(daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archived, clientId: 'restore-crash-test' }), /Restoration destination already exists/);
    rmSync(chat.path);
    const archivedSnapshots = archived.replace(/\.jsonl$/, '.snapshots');
    const original = readFileSync(archived, 'utf8');
    const observe = () => ({ active: existsSync(chat.path), archived: existsSync(archived), activeSnapshots: existsSync(snapshots), archivedSnapshots: existsSync(archivedSnapshots) });
    const before = { active: false, archived: true, activeSnapshots: false, archivedSnapshots: true };
    const after = { active: true, archived: false, activeSnapshots: true, archivedSnapshots: false };
    assert.deepEqual(observe(), before);
    const result = await run({ action: 'restore', paths: [archived], root: profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });
    if (result.status !== 0) assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    else {
      assert.equal(result.outcome.state, 'committed');
      assert.deepEqual(result.outcome.result.sessions, [{ path: home, sessionPath: chat.path, sessionId: chat.id, sourcePath: archived }]);
    }
    const recovered = await run({ action: 'recover', root: profile });
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    const state = observe();
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    assert.equal(readFileSync(state.active ? chat.path : archived, 'utf8'), original);
    assert.deepEqual(tree(state.active ? snapshots : archivedSnapshots), ['one.json={}']);
    const repeated = await run({ action: 'recover', root: profile });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.deepEqual(observe(), state);
    assert.equal(readFileSync(otherPath, 'utf8'), otherContent);
    assert.equal(readFileSync(goalPath, 'utf8'), objective);
    assert.deepEqual(goalOwners(profile, goal), ownersBeforeMove, 'moving a chat must not change attachment ownership');
    const surviving = state.active ? chat.path : archived;
    const deleted = await run({ action: 'delete', targets: [{ path: surviving, area: state.active ? 'sessions' : 'archived', root: join(profile, state.active ? 'sessions' : 'archived') }], activeSessionIds: [] });
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.equal(existsSync(goal), false, 'deleting the last chat releases its goal folder');
    assert.equal(readFileSync(otherPath, 'utf8'), otherContent);
    if (result.status === 0) {
      assert.deepEqual(state, after);
      break;
    }
    outcomes.add(state.active ? 'after' : 'before');
  }
  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('restore that rejects a later attachment leaves all attachment ownership unchanged', async t => {
  const daemon = await daemonClient(t);
  const prepareGoal = await goalCommand(t);
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const profile = join(home, '.piop');
  const chats = [];
  for (const objective of ['First objective. '.repeat(300).trim(), 'Second objective. '.repeat(300).trim()]) {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home, content: '', controlsBundle }),
    }));
    const prepared = await prepareGoal(chat.path, objective);
    const goalPath = prepared.message.match(/Read the goal objective file at (.+?) before continuing\./)[1];
    const goal = dirname(goalPath);
    const ownersBeforeMove = goalOwners(profile, goal);
    goalTranscript(chat.path, JSON.parse(readFileSync(chat.path, 'utf8').split('\n')[0]), goal);
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'restore-failure-test' });
    const report = await daemon.invoke('storage_report');
    const archived = report.hosts.find(host => host.hostId === 'local').archives.find(row => row.id === chat.id).path;
    writeFileSync(chat.path, 'Occupied destination');
    await assert.rejects(daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archived, clientId: 'restore-failure-test' }), /Restoration destination already exists/);
    rmSync(chat.path);
    assert.deepEqual(goalOwners(profile, goal), ownersBeforeMove);
    chats.push({ ...chat, archived, goal, files: tree(goal), content: readFileSync(archived, 'utf8') });
  }
  const displaced = chats[1].goal + '-displaced';
  renameSync(chats[1].goal, displaced);
  symlinkSync(displaced, chats[1].goal);
  const result = await run({ action: 'restore', paths: chats.map(chat => chat.archived), root: profile });
  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.ok(result.outcome.error.includes(chats[1].goal), result.outcome.error);
  for (const [index, chat] of chats.entries()) {
    assert.equal(existsSync(chat.path), false);
    assert.equal(readFileSync(chat.archived, 'utf8'), chat.content);
    assert.deepEqual(tree(index === 1 ? displaced : chat.goal), chat.files);
  }
  rmSync(chats[1].goal);
  renameSync(displaced, chats[1].goal);
  const recovered = await run({ action: 'recover', root: profile });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  for (const chat of chats) {
    const deleted = await run({ action: 'delete', targets: [{ path: chat.archived, area: 'archived', root: join(profile, 'archived') }], activeSessionIds: [] });
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.equal(existsSync(chat.goal), false, 'failed moves must not retain deleted goal files');
  }
});


test('archive inspection does not turn a reference into a new attachment owner', async t => {
  const current = fixture(t);
  const prepareGoal = await goalCommand(t);
  const prepared = await prepareGoal(current.target, 'Keep this attachment. '.repeat(200).trim());
  const goal = dirname(prepared.message.match(/Read the goal objective file at (.+?) before continuing\./)[1]);
  const before = goalOwners(current.profile, goal);
  const otherId = crypto.randomUUID();
  const entries = [
    { type: 'session', id: otherId, cwd: current.profile },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Read ' + join(goal, 'goal-objective.md') } },
  ];
  assert.deepEqual(historyContract(current.profile, entries, otherId).directories, []);
  assert.equal(historyContract(current.profile, entries, sessionId).directories[0].path, goal);
  assert.deepEqual(goalOwners(current.profile, goal), before);
});

/** Gives the fixture chat the ownership record that a restore updates. */
function own(current) {
  conversationStorage.writeRecord(current.profile, conversationStorage.key(sessionId), JSON.stringify({ path: current.target, deleted: false, client: null }));
}

test('restore with a moved worktree folder rewrites the folder atomically after a crash at any write', async t => {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    assert.ok(crashAfter < maxCrashes, 'no committed run within ' + maxCrashes + ' crash points');
    const current = fixture(t);
    own(current);
    const from = dirname(current.profile);
    const to = join(from, 'restored-worktree');
    mkdirSync(to);
    const archived = await run({ action: 'archive', paths: [current.target], root: current.profile });
    assert.equal(archived.status, 0, archived.stdout + archived.stderr);
    const path = archived.outcome.result.sessions[0].sessionPath;
    const [header, ...rest] = readFileSync(path, 'utf8').split('\n');
    const observe = () => {
      const active = existsSync(current.target);
      const file = active ? current.target : path;
      const lines = readFileSync(file, 'utf8').split('\n');
      return { active, archived: existsSync(path), cwd: JSON.parse(lines[0]).cwd, body: lines.slice(1).join('\n'), snapshots: tree(file.replace(/\.jsonl$/, '.snapshots')) };
    };
    const before = { active: false, archived: true, cwd: from, body: rest.join('\n'), snapshots: ['one.json={}'] };
    const after = { ...before, active: true, archived: false, cwd: to };
    assert.equal(JSON.parse(header).cwd, from);
    const result = await run({ action: 'restore', paths: [path], root: current.profile, cwdMoves: [{ from, to }] }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });
    if (result.status !== 0) assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    else assert.deepEqual(result.outcome.result.sessions, [{ path: to, sessionPath: current.target, sessionId, sourcePath: path }]);
    const recovered = await run({ action: 'recover', root: current.profile });
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    const state = observe();
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    assert.deepEqual(readdirSync(join(current.profile, 'storage-transactions')), []);
    if (result.status === 0) {
      assert.deepEqual(state, after);
      const receipt = await run({ action: 'result', path, root: current.profile });
      assert.equal(receipt.status, 0, receipt.stdout + receipt.stderr);
      assert.deepEqual(receipt.outcome.result, result.outcome.result);
      break;
    }
    outcomes.add(state.active ? 'after' : 'before');
  }
  assert.ok(outcomes.has('before'));
});

test('restore rejects a moved folder that does not exist and leaves the archive unchanged', async t => {
  const current = fixture(t);
  own(current);
  const archived = await run({ action: 'archive', paths: [current.target], root: current.profile });
  assert.equal(archived.status, 0, archived.stdout + archived.stderr);
  const path = archived.outcome.result.sessions[0].sessionPath;
  const content = readFileSync(path, 'utf8');
  const missing = join(dirname(current.profile), 'missing');
  const result = await run({ action: 'restore', paths: [path], root: current.profile, cwdMoves: [{ from: dirname(current.profile), to: missing }] });
  assert.equal(result.status, 1);
  assert.equal(result.outcome.state, 'rolled-back');
  assert.equal(result.outcome.error, 'Restore failed: Restored folder does not exist: ' + missing);
  assert.equal(readFileSync(path, 'utf8'), content);
  assert.equal(existsSync(current.target), false);
});

});
