import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, constants, existsSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

let home: string;
let root: string;
let previousStorage: string | undefined;
let modules: any;

beforeAll(async () => {
  previousStorage = process.env.PIOP_STORAGE_DIRECTORY;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'piop-branch-history-')));
  root = join(home, '.piop');
  mkdirSync(join(root, 'sessions', 'project'), { recursive: true });
  // Storage code finds its root from the home folder and this setting.
  process.env.PIOP_STORAGE_DIRECTORY = relative(realpathSync(homedir()), root);
  modules = {
    history: await import('../../daemon/src/chat_branch_history'),
    publication: require('../../daemon/resources/piop-storage/session-publication.cjs'),
    database: require('../../daemon/resources/session-database.cjs'),
    assets: require('../../daemon/resources/piop-storage/goal-assets.cjs'),
    dependencies: require('../../daemon/resources/piop-storage/goal-dependencies.cjs'),
    goals: require('../../daemon/resources/piop-storage/goals.cjs'),
    records: require('../../daemon/resources/piop-storage/session-records.cjs'),
    lock: require('../../daemon/resources/piop-storage/reference-publication-lock.cjs'),
    operation: require('../../daemon/resources/storage-operation.cjs'),
  };
});
afterAll(() => {
  if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
  rmSync(home, { recursive: true, force: true }); });

const text = (value: string) => [{ type: 'text', text: value }];
const message = (id: string, parentId: string | null, role: string, content: any, extra: any = {}) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content, timestamp: 1, ...extra } });

/** A published source chat whose first message references a shared goal attachment, with a saved goal. */
async function sourceChat() {
  const { database, dependencies, publication, lock, goals } = modules;
  const attachment = join(root, 'sessions', 'project', 'attachments', 'goal-' + randomUUID().replace(/-/g, '').slice(0, 6));
  mkdirSync(attachment, { recursive: true });
  writeFileSync(join(attachment, 'goal-objective.md'), 'Ship it');
  dependencies.saveTextFiles(root, attachment, ['goal-objective.md']);
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const id = database.reserve(root);
  const path = join(root, 'sessions', 'project', '2026-10-20T00-00-00-000Z_' + id + '.jsonl');
  const entries = [
    message('u1', null, 'user', text('Read ' + attachment + '/goal-objective.md')),
    message('a1', 'u1', 'assistant', text('First answer'), { stopReason: 'stop' }),
    message('u2', 'a1', 'user', text('More')),
    message('a2', 'u2', 'assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }], { stopReason: 'toolUse' }),
    message('t2', 'a2', 'toolResult', text('done'), { toolCallId: 'call' }),
    message('a3', 't2', 'assistant', text('Second answer'), { stopReason: 'stop' }),
  ];
  const current = [
    { type: 'session_info', id: 'name', parentId: null, timestamp: new Date().toISOString(), name: 'Source' },
    { type: 'thinking_level_change', id: 'thinking', parentId: null, timestamp: new Date().toISOString(), thinkingLevel: 'high' },
  ];
  const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd };
  await publication.publish(path, [header, ...entries, ...current].map(entry => JSON.stringify(entry)).join('\n') + '\n', async (operation: any) => {
    const release = lock.acquireReferencePublicationLock(root, true);
    try { return await operation(); } finally { release(); }
  }, { dependencies: { workspace: { path: cwd, kind: 'existing' } } });
  goals.write(path, id, { id: randomUUID(), sessionId: id, objective: 'Keep going', status: 'active' });
  return { id, path, cwd, attachment, entries: [...entries, ...current] };
}

/** Deletes a chat the way the daemon's storage worker does. */
async function deleteChat(path: string) {
  const open = (file: string) => openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const locks = { restore: open(join(root, 'restore.lock')), transactions: open(join(root, 'session-transactions.lock')) };
  try { return await modules.operation.runStorageTransaction({ root, locks, begin: () => true }, { action: 'delete', targets: [{ area: 'sessions', path }], activeSessionIds: [] }); }
  finally { Object.values(locks).forEach(descriptor => closeSync(descriptor)); }
}

function owners(directory: string) { return modules.assets.readOwners(root, directory).owners.map((owner: any) => owner.sessionId).sort(); }

function registered(id: string) {
  const db = modules.database.open(root);
  try { return db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id)?.session_path; } finally { db.close(); }
}

function leftovers(id: string, path: string) {
  const db = modules.database.open(root);
  try {
    return {
      transcript: existsSync(path),
      registry: Boolean(db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id)),
      goal: Boolean(db.prepare('SELECT 1 FROM session_goals WHERE session_id=?').get(id)),
      state: db.prepare('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(id).n,
      journals: modules.database.publications(root).length,
      quarantine: existsSync(join(root, 'session-publication-quarantine')) ? readdirSync(join(root, 'session-publication-quarantine')).length : 0,
      locks: existsSync(join(root, 'session-publication-locks')) ? readdirSync(join(root, 'session-publication-locks')).length : 0,
    };
  } finally { db.close(); }
}

test('a branch copies history through the selected final response, current settings and shared attachments, and discarding it leaves the source intact', async () => {
  const source = await sourceChat();
  const sourceBody = readFileSync(source.path, 'utf8');
  const sessionId = modules.database.reserve(root);
  const locksBefore = leftovers(source.id, source.path).locks;
  const result = await modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' });

  expect(result.forkSource).toEqual({ sessionId: source.id, sessionPath: source.path, entryId: 'a1' });
  const saved = readFileSync(result.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved[0]).toMatchObject({ type: 'session', id: sessionId, cwd: source.cwd, parentSession: source.path, piopForkSource: result.forkSource });
  expect(saved.slice(1).map((entry: any) => entry.id)).toEqual(['u1', 'a1']);
  expect(registered(sessionId)).toBe(result.sessionPath);
  expect(modules.records.sessionName(result.sessionPath, sessionId)).toBe('Source (branch)');
  const settings = modules.records.records(result.sessionPath, sessionId).map((record: any) => record.entry);
  expect(settings.map((entry: any) => entry.customType ?? entry.type).sort()).toEqual(['piop-input-hold', 'session_info', 'thinking_level_change']);
  // The branch waits for the user's first message.
  expect(settings.find((entry: any) => entry.customType === 'piop-input-hold').data).toEqual({ held: true });
  expect(settings.find((entry: any) => entry.type === 'thinking_level_change').thinkingLevel).toBe('high');
  expect(modules.goals.read(result.sessionPath, sessionId)).toMatchObject({ objective: 'Keep going', sessionId });
  expect(owners(source.attachment)).toEqual([source.id, sessionId].sort());

  await modules.history.discardBranchHistory(root, sessionId, result.sessionPath);
  expect(leftovers(sessionId, result.sessionPath)).toMatchObject({ transcript: false, registry: false, goal: false, state: 0, journals: 0, locks: locksBefore });
  expect(owners(source.attachment)).toEqual([source.id]);
  expect(existsSync(join(source.attachment, 'goal-objective.md'))).toBe(true);
  expect(readFileSync(source.path, 'utf8')).toBe(sourceBody);
  expect(modules.goals.read(source.path, source.id)).toMatchObject({ objective: 'Keep going' });

  await modules.history.discardBranchHistory(root, sessionId, result.sessionPath);
  await modules.history.discardBranchHistory(root, sessionId, null);
});

test('a publication that fails after claiming resources removes everything it created', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const locksBefore = leftovers(source.id, source.path).locks;
  const db = modules.database.open(root);
  db.exec("CREATE TRIGGER reject_branch_state BEFORE INSERT ON session_child_state WHEN NEW.session_id='" + sessionId + "' BEGIN SELECT RAISE(ABORT, 'Index write failed'); END");
  db.close();
  try {
    await expect(modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a3' }))
      .rejects.toThrow(/Could not create the branch: Index write failed/);
  } finally {
    const cleanup = modules.database.open(root);
    cleanup.exec('DROP TRIGGER reject_branch_state');
    cleanup.close();
  }
  const files = readdirSync(join(root, 'sessions', 'project')).filter(name => name.includes(sessionId));
  expect(files).toEqual([]);
  expect(leftovers(sessionId, join(root, 'missing'))).toMatchObject({ registry: false, goal: false, state: 0, journals: 0, quarantine: 0, locks: locksBefore });
  expect(owners(source.attachment)).toEqual([source.id]);
});

test('only finished final responses on the current branch can be branched from', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const request = { root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3' };
  await expect(modules.history.publishBranchHistory({ ...request, entryId: 'a2' })).rejects.toThrow(/finished final response/);
  await expect(modules.history.publishBranchHistory({ ...request, entryId: 'a1', leafId: 'u1' })).rejects.toThrow(/not on the current branch/);
  expect(registered(sessionId)).toBeNull();
  expect(owners(source.attachment)).toEqual([source.id]);
});

test('discarding refuses a conversation that is not a branch', async () => {
  const source = await sourceChat();
  await expect(modules.history.discardBranchHistory(root, source.id, source.path)).rejects.toThrow(/not this branch/);
  expect(existsSync(source.path)).toBe(true);
  expect(registered(source.id)).toBe(source.path);
});

test('shared attachments stay while the branch exists after its source is deleted, and go with the last chat', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const branch = await modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' });
  const remove = (path: string) => deleteChat(path);

  const removed = await remove(source.path);
  expect(removed).toMatchObject({ state: 'committed' });
  expect(existsSync(source.path)).toBe(false);
  expect(readFileSync(join(source.attachment, 'goal-objective.md'), 'utf8')).toBe('Ship it');
  expect(owners(source.attachment)).toEqual([sessionId]);

  expect((await remove(branch.sessionPath)).state).toBe('committed');
  expect(existsSync(source.attachment)).toBe(false);
});

test('a publication that saves the transcript but cannot finish is removed', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const locksBefore = leftovers(source.id, source.path).locks;
  const db = modules.database.open(root);
  // The transcript is linked before its publication record is retired; failing that retirement leaves it only partly saved.
  db.exec("CREATE TRIGGER keep_branch_publication BEFORE DELETE ON session_publications WHEN json_extract(OLD.record_json, '$.sessionId')='" + sessionId + "' AND json_extract(OLD.record_json, '$.phase')='linked' BEGIN SELECT RAISE(ABORT, 'Retirement failed'); END");
  db.close();
  try {
    await expect(modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' }))
      .rejects.toThrow(/Session was published; durability or cleanup will retry[\s\S]*Cleanup failed: Branch cleanup is incomplete/);
  } finally {
    const cleanup = modules.database.open(root);
    cleanup.exec('DROP TRIGGER keep_branch_publication');
    cleanup.close();
  }
  // Recovery retries with only the branch identity.
  await modules.history.discardBranchHistory(root, sessionId, null);
  expect(readdirSync(join(root, 'sessions', 'project')).filter(name => name.includes(sessionId))).toEqual([]);
  expect(leftovers(sessionId, join(root, 'missing'))).toMatchObject({ registry: false, goal: false, state: 0, journals: 0, quarantine: 0, locks: locksBefore });
  expect(owners(source.attachment)).toEqual([source.id]);
});

for (const customType of ['piop-subagent-parent', 'piop-review-parent']) test(`worktree history rejects ${customType} even outside the selected history`, async () => {
  const source = await sourceChat();
  const body = readFileSync(source.path, 'utf8');
  source.entries.push({ type: 'custom', id: 'parent-marker', parentId: null, timestamp: new Date().toISOString(), customType, data: { parentSessionId: 'parent' } } as any);
  await expect(modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId: modules.database.reserve(root), cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' })).rejects.toThrow('Only main chats can be forked');
  expect(readFileSync(source.path, 'utf8')).toBe(body);
});
