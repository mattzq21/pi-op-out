import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const entry = join(process.cwd(), 'daemon/resources/storage-transaction-command.cjs');

const goalDependencies = createRequire(import.meta.url)('../../daemon/resources/session-broker/goal-dependencies.cjs');

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

const ownershipKey = createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40);

function archivedFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'piop-storage-transaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  const archived = join(profile, 'archived');
  const sessions = join(profile, 'sessions');
  const target = join(archived, 'target.jsonl');
  const destination = join(sessions, 'target.jsonl');
  mkdirSync(join(archived, 'target.snapshots'), { recursive: true });
  mkdirSync(sessions);
  writeFileSync(target, JSON.stringify({ type: 'session', id: sessionId, cwd: directory, archiveSessionPath: destination }) + '\n');
  writeFileSync(join(archived, 'target.snapshots', 'one.json'), '{}');
  writeFileSync(target + '.loop-detection.json', '{}');
  writeFileSync(join(archived, 'other.jsonl'), JSON.stringify({ type: 'session', id: 'other', cwd: directory }) + '\n');
  const database = new DatabaseSync(join(profile, 'sessions.sqlite'));

  try {
    database.exec('CREATE TABLE conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT)');
    database.prepare('INSERT INTO conversation_ownership VALUES (?, ?)').run(ownershipKey, JSON.stringify({ path: target, deleted: true, client: null }));
  } finally { database.close(); }

  return { profile, archived, sessions, target, destination };
}

function ownership(profile) {
  const database = new DatabaseSync(join(profile, 'sessions.sqlite'), { readOnly: true });

  try { return database.prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(ownershipKey).record_json; }
  finally { database.close(); }
}

const restoreState = current => ({ archived: tree(current.archived), sessions: tree(current.sessions), ownership: JSON.parse(ownership(current.profile)) });

test('restore fully happens or fully rolls back after a crash at any write', t => {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    const current = archivedFixture(t);
    const before = restoreState(current);

    const after = {
      archived: before.archived.filter(line => line.startsWith('other.jsonl')),
      sessions: before.archived.filter(line => line.startsWith('target')),
      ownership: { path: current.destination, deleted: false, client: null },
    };

    const result = run({ action: 'restore', paths: [current.target], root: current.profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      const output = JSON.parse(result.stdout);
      assert.equal(output.state, 'committed');
      assert.deepEqual(output.result.sessions, [{ path: current.target.replace('/profile/archived/target.jsonl', ''), sessionPath: current.destination, sessionId, sourcePath: current.target }]);
      assert.deepEqual(restoreState(current), after);
      settled(current.profile);
      const receipt = run({ action: 'result', path: current.target, root: current.profile });
      assert.equal(receipt.status, 0, receipt.stderr);
      assert.deepEqual(JSON.parse(receipt.stdout).result, output.result);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stderr);
    const state = restoreState(current);
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    settled(current.profile);
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected restore leaves storage unchanged', t => {
  const current = archivedFixture(t);
  writeFileSync(current.destination, 'taken');
  const before = restoreState(current);
  const result = run({ action: 'restore', paths: [current.target], root: current.profile });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).state, 'rolled-back');
  assert.equal(result.stderr.trim(), 'Restore failed: Restoration destination already exists: ' + current.destination + '\nRestore was rolled back.');
  assert.deepEqual(restoreState(current), before);
  assert.equal(existsSync(join(current.profile, 'storage-transactions')), false);
  assert.equal(journals(current.profile), 0);
});

function activeFixture(t) {
  const current = fixture(t);
  const archived = join(current.profile, 'archived');
  const database = new DatabaseSync(join(current.profile, 'sessions.sqlite'));

  mkdirSync(archived);

  try {
    database.exec('CREATE TABLE conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT)');
    database.prepare('INSERT INTO conversation_ownership VALUES (?, ?)').run(ownershipKey, JSON.stringify({ path: current.target, deleted: false, client: 'one' }));
  } finally { database.close(); }

  return { ...current, archived, name: 'session-' + sessionId };
}

function archivedState(current) {
  const header = JSON.parse(readFileSync(current.target, 'utf8'));
  const archivedHeader = { ...header, archiveSessionPath: current.target, goalAssets: { version: 1, policy: 'shared-profile', directories: [] } };

  return {
    archived: [current.name + '.jsonl=' + JSON.stringify(archivedHeader) + '\n', current.name + '.jsonl.loop-detection.json={}', current.name + '.snapshots/', current.name + '.snapshots/one.json={}'],
    sessions: tree(current.sessions).filter(line => line.startsWith('other.jsonl')),
    ownership: { path: current.target, deleted: true, client: null },
  };
}

test('archive fully happens or fully rolls back after a crash at any write', t => {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    const current = activeFixture(t);
    const before = restoreState(current);
    const after = archivedState(current);
    const result = run({ action: 'archive', paths: [current.target], root: current.profile }, { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      assert.deepEqual(JSON.parse(result.stdout), { state: 'committed', result: { sessions: [{ sessionId, sourcePath: current.target, sessionPath: join(current.archived, current.name + '.jsonl') }] } });
      assert.deepEqual(restoreState(current), after);
      settled(current.profile);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stderr);
    const state = restoreState(current);
    assert.ok([before, after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    settled(current.profile);
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
});

test('rejected archive leaves storage unchanged', t => {
  const current = activeFixture(t);
  const taken = join(current.archived, current.name + '.jsonl');
  writeFileSync(taken, 'taken');
  const before = restoreState(current);
  const result = run({ action: 'archive', paths: [current.target], root: current.profile });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).state, 'rolled-back');
  assert.equal(result.stderr.trim(), 'Archive failed: Archive destination already exists: ' + taken + '\nArchive was rolled back.');
  assert.deepEqual(restoreState(current), before);
  assert.equal(existsSync(join(current.profile, 'storage-transactions')), false);
  assert.equal(journals(current.profile), 0);
});

const secondId = '7a3d2e5f-9b0c-4d4e-8f2a-1b2c3d4e5f60';

const secondKey = createHash('sha256').update(secondId).digest('hex').slice(0, 40);

function goalFolder(profile, name) {
  const directory = join(profile, 'attachments', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'goal-objective.md'), 'Ship it');
  goalDependencies.saveTextFiles(profile, directory, ['goal-objective.md']);

  return directory;
}

function folderIdentity(directory) {
  const metadata = lstatSync(directory, { bigint: true });

  return metadata.dev + ':' + metadata.ino;
}

function damageOwners(profile, directory) {
  const database = new DatabaseSync(join(profile, 'sessions.sqlite'));

  try {
    database.exec('CREATE TABLE IF NOT EXISTS goal_ownership (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity))');
    database.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?)').run(directory, folderIdentity(directory), JSON.stringify({ damaged: true }));
  } finally { database.close(); }
}

function goalOwners(profile) {
  const database = new DatabaseSync(join(profile, 'sessions.sqlite'), { readOnly: true });

  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_ownership'").get()) return [];

    return database.prepare('SELECT directory, record_json FROM goal_ownership WHERE record_json IS NOT NULL ORDER BY directory').all().map(row => ({ directory: row.directory, record: JSON.parse(row.record_json) }));
  } finally { database.close(); }
}

function goalTranscript(file, header, goal) {
  const message = { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Read ' + join(goal, 'goal-objective.md') } };
  const text = JSON.stringify(header) + '\n' + JSON.stringify(message) + '\n';
  writeFileSync(file, text);

  return text;
}

const goalState = current => ({ ...restoreState(current), goals: goalOwners(current.profile) });

const ownedBy = (goal, sessionPath) => [{ directory: goal, record: { version: 1, kind: 'goal-assets', owners: [{ sessionId, sessionPath }] } }];

function crashLoop(t, make, request) {
  const outcomes = new Set();

  for (let crashAfter = 0; ; crashAfter += 1) {
    const current = make(t);
    const before = goalState(current);
    const result = run(request(current), { PIOP_STORAGE_TRANSACTION_CRASH_AFTER: String(crashAfter) });

    if (result.status === 0) {
      assert.equal(JSON.parse(result.stdout).state, 'committed');
      assert.deepEqual(goalState(current), current.after);
      settled(current.profile);
      break;
    }

    assert.equal(result.stdout, '', 'crash ' + crashAfter + ' wrote a result: ' + result.stderr);
    const recovery = run({ action: 'recover', root: current.profile });
    assert.equal(recovery.status, 0, recovery.stderr);
    const state = goalState(current);
    assert.ok([before, current.after].some(expected => JSON.stringify(expected) === JSON.stringify(state)), 'crash ' + crashAfter + ' left ' + JSON.stringify(state));
    outcomes.add(JSON.stringify(state) === JSON.stringify(before) ? 'before' : 'after');
    settled(current.profile);
  }

  assert.deepEqual([...outcomes].sort(), ['after', 'before']);
}

function rejectedClaim(current, request, label) {
  const before = goalState(current);
  const result = run(request);

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).state, 'rolled-back');
  assert.equal(result.stderr.trim(), label + ' failed: Damaged goal ownership retained: ' + current.second + '\n' + label + ' was rolled back.');
  assert.deepEqual(goalState(current), before);
  settled(current.profile);
}

function goalArchiveFixture(t) {
  const current = activeFixture(t);
  const goal = goalFolder(current.profile, 'goal-one');
  const header = JSON.parse(readFileSync(current.target, 'utf8'));
  const text = goalTranscript(current.target, header, goal);
  const archivedHeader = { ...header, archiveSessionPath: current.target, goalAssets: { version: 1, policy: 'shared-profile', directories: [{ path: goal, identity: folderIdentity(goal) }] } };
  const destination = join(current.archived, current.name + '.jsonl');

  const after = {
    archived: [current.name + '.jsonl=' + JSON.stringify(archivedHeader) + '\n' + text.split('\n')[1] + '\n', current.name + '.jsonl.loop-detection.json={}', current.name + '.snapshots/', current.name + '.snapshots/one.json={}'],
    sessions: tree(current.sessions).filter(line => line.startsWith('other.jsonl')),
    ownership: { path: current.target, deleted: true, client: null },
    goals: ownedBy(goal, destination),
  };

  return { ...current, goal, after };
}

test('archive with goal folders fully happens or fully rolls back after a crash at any write', t => {
  crashLoop(t, goalArchiveFixture, current => ({ action: 'archive', paths: [current.target], root: current.profile }));
});

test('archive that fails a later goal claim undoes the earlier goal claim', t => {
  const current = goalArchiveFixture(t);
  const second = goalFolder(current.profile, 'goal-two');
  const file = join(current.sessions, 'second.jsonl');
  goalTranscript(file, { type: 'session', id: secondId, cwd: current.profile }, second);
  damageOwners(current.profile, second);

  rejectedClaim({ ...current, second }, { action: 'archive', paths: [current.target, file], root: current.profile }, 'Archive');
});

function goalRestoreFixture(t) {
  const current = archivedFixture(t);
  const goal = goalFolder(current.profile, 'goal-one');
  goalTranscript(current.target, JSON.parse(readFileSync(current.target, 'utf8')), goal);
  const archived = tree(current.archived);

  const after = {
    archived: archived.filter(line => line.startsWith('other.jsonl')),
    sessions: archived.filter(line => line.startsWith('target')),
    ownership: { path: current.destination, deleted: false, client: null },
    goals: ownedBy(goal, current.destination),
  };

  return { ...current, goal, after };
}

test('restore with goal folders fully happens or fully rolls back after a crash at any write', t => {
  crashLoop(t, goalRestoreFixture, current => ({ action: 'restore', paths: [current.target], root: current.profile }));
});

test('restore that fails a later goal claim undoes the earlier goal claim', t => {
  const current = goalRestoreFixture(t);
  const second = goalFolder(current.profile, 'goal-two');
  const file = join(current.archived, 'second.jsonl');
  goalTranscript(file, { type: 'session', id: secondId, cwd: current.profile, archiveSessionPath: join(current.sessions, 'second.jsonl') }, second);
  damageOwners(current.profile, second);
  const database = new DatabaseSync(join(current.profile, 'sessions.sqlite'));

  try { database.prepare('INSERT INTO conversation_ownership VALUES (?, ?)').run(secondKey, JSON.stringify({ path: file, deleted: true, client: null })); }
  finally { database.close(); }

  rejectedClaim({ ...current, second }, { action: 'restore', paths: [current.target, file], root: current.profile }, 'Restore');
});
