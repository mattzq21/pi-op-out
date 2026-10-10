import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const entry = join(process.cwd(), 'daemon/resources/storage-transaction-command.cjs');

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
  writeFileSync(target + '.loop-detection.json', '{}');
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

function run(request, environment = {}) {
  return spawnSync(process.execPath, [entry, JSON.stringify(request)], { encoding: 'utf8', env: { ...process.env, ...environment } });
}

function journals(profile) {
  const database = new DatabaseSync(join(profile, 'sessions.sqlite'), { readOnly: true });

  try { return database.prepare('SELECT count(*) AS count FROM storage_transactions').get().count; }
  finally { database.close(); }
}

function settled(profile) {
  const staging = join(profile, 'storage-transactions');

  assert.equal(journals(profile), 0);
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], []);
}

const deletion = fixture => ({ action: 'delete', targets: [{ path: fixture.target, area: 'sessions', root: fixture.sessions }], activeSessionIds: [] });

test('delete fully happens or fully rolls back after a crash at any write', t => {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    const current = fixture(t);
    const before = tree(current.sessions);
    const after = before.filter(line => line.startsWith('other.jsonl'));
    const result = run(deletion(current), { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      assert.equal(JSON.parse(result.stdout).state, 'committed');
      assert.deepEqual(tree(current.sessions), after);
      settled(current.profile);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stderr);
    const state = tree(current.sessions);
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + state.join(', '));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    settled(current.profile);
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected delete leaves storage unchanged', t => {
  const current = fixture(t);
  const before = tree(current.sessions);
  const result = run({ ...deletion(current), activeSessionIds: [sessionId] });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).state, 'rolled-back');
  assert.equal(result.stderr.trim(), 'Deletion failed: Close the session before deleting it\nDeletion was rolled back.');
  assert.deepEqual(tree(current.sessions), before);
  assert.equal(existsSync(join(current.profile, 'storage-transactions')), false);
  assert.equal(journals(current.profile), 0);
});
