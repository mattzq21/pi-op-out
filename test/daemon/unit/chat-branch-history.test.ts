import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
  process.env.PIOP_STORAGE_DIRECTORY = relative(realpathSync(homedir()), root);
  modules = {
    history: await import('../../../daemon/src/host_operations/branch_history'),
    newChats: require('../../../daemon/resources/storage-operations/new-chats.ts'),
    database: require('../../../daemon/resources/session-database/index.ts'),
    core: require('../../../daemon/resources/session-database/core.ts'),
    goalFiles: require('../../../daemon/resources/storage-operations/goal-files.ts'),
    goals: require('../../../daemon/resources/storage-operations/goals.ts'),
    records: require('../../../daemon/resources/piop-storage/session-records.ts'),
    names: require('../../../daemon/resources/piop-storage/session-names.ts'),
    lifecycle: require('../../../daemon/resources/chat-storage/lifecycle.ts'),
    locks: require('../../../daemon/resources/chat-storage/locks.ts'),
  };
});
afterAll(() => {
  if (previousStorage === undefined) delete process.env.PIOP_STORAGE_DIRECTORY; else process.env.PIOP_STORAGE_DIRECTORY = previousStorage;
  rmSync(home, { recursive: true, force: true }); });

const text = (value: string) => [{ type: 'text', text: value }];
const message = (id: string, parentId: string | null, role: string, content: any, extra: any = {}) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content, timestamp: 1, ...extra } });

// A goal objective long enough to reach the agent as a goal file.
const OBJECTIVE = 'Keep going. ' + 'x'.repeat(5000);

async function sourceChat(objective = OBJECTIVE) {
  const { database, newChats, goals } = modules;
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const id = database.reserve(root);
  const path = join(root, 'sessions', 'project', '2026-10-20T00-00-00-000Z_' + id + '.jsonl');
  const entries = [
    message('u1', null, 'user', text('Ship it')),
    message('a1', 'u1', 'assistant', text('First answer'), { stopReason: 'stop' }),
    message('u2', 'a1', 'user', text('More')),
    message('a2', 'u2', 'assistant', [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }], { stopReason: 'toolUse' }),
    message('t2', 'a2', 'toolResult', text('done'), { toolCallId: 'call' }),
    message('a3', 't2', 'assistant', text('Second answer'), { stopReason: 'stop' }),
  ];
  const current = [
    { type: 'thinking_level_change', id: 'thinking', parentId: null, timestamp: new Date().toISOString(), thinkingLevel: 'high' },
  ];
  const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd };
  newChats.create(root, { path, entries: [header, ...entries, ...current], name: 'Source' });
  goals.write(path, id, { id: randomUUID(), sessionId: id, objective, status: 'active' });
  return { id, path, cwd, entries: [...entries, ...current] };
}

async function deleteChat(path: string) {
  return modules.locks.withinFlow(() => modules.lifecycle.run({ root, begin: () => true }, { action: 'delete', sessionIds: [modules.lifecycle.idOf(root, path)] }));
}

function registered(id: string) {
  return modules.database.lookup(root, id);
}

function leftovers(id: string, path: string) {
  const db = modules.core.connection(root);
  return {
    transcript: existsSync(path),
    registry: Boolean(db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id)),
    goal: Boolean(db.prepare('SELECT 1 FROM session_goals WHERE session_id=?').get(id)),
    state: db.prepare('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(id).n,
  };
}

test('a branch copies history through the selected final response, current settings and the goal, and discarding it leaves the source intact', async () => {
  const source = await sourceChat();
  const sourceBody = readFileSync(source.path, 'utf8');
  const sessionId = modules.database.reserve(root);
  const result = await modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' });

  expect(result.forkSource).toEqual({ sessionId: source.id, sessionPath: source.path, entryId: 'a1' });
  const saved = readFileSync(result.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved[0]).toMatchObject({ type: 'session', id: sessionId, cwd: source.cwd, parentSession: source.path, piopForkSource: result.forkSource });
  expect(saved.slice(1).map((entry: any) => entry.id)).toEqual(['u1', 'a1']);
  expect(registered(sessionId)).toBe(result.sessionPath);
  expect(modules.names.sessionName(result.sessionPath, sessionId)).toBe('Source (branch)');
  const settings = modules.records.records(result.sessionPath, sessionId).map((record: any) => record.entry);
  expect(settings.map((entry: any) => entry.customType ?? entry.type).sort()).toEqual(['piop-input-hold', 'thinking_level_change']);
  expect(settings.find((entry: any) => entry.customType === 'piop-input-hold').data).toEqual({ held: true });
  expect(settings.find((entry: any) => entry.type === 'thinking_level_change').thinkingLevel).toBe('high');
  expect(modules.goals.read(result.sessionPath, sessionId)).toMatchObject({ objective: OBJECTIVE, sessionId });

  await modules.history.discardBranchHistory(root, sessionId, result.sessionPath);
  expect(leftovers(sessionId, result.sessionPath)).toMatchObject({ transcript: false, registry: false, goal: false, state: 0 });
  expect(readFileSync(source.path, 'utf8')).toBe(sourceBody);
  expect(modules.goals.read(source.path, source.id)).toMatchObject({ objective: OBJECTIVE });

  await modules.history.discardBranchHistory(root, sessionId, result.sessionPath);
  await modules.history.discardBranchHistory(root, sessionId, null);
});

test('a branch whose commit fails leaves no files and no rows', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const db = modules.core.connection(root);
  db.exec("CREATE TRIGGER reject_branch_state BEFORE UPDATE OF session_path ON sessions WHEN NEW.session_id='" + sessionId + "' BEGIN SELECT RAISE(ABORT, 'Index write failed'); END");
  try {
    await expect(modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a3' }))
      .rejects.toThrow(/Could not create the branch: Index write failed/);
  } finally {
    const cleanup = modules.core.connection(root);
    cleanup.exec('DROP TRIGGER reject_branch_state');
  }
  const files = readdirSync(join(root, 'sessions', 'project')).filter(name => name.includes(sessionId));
  expect(files).toEqual([]);
  expect(leftovers(sessionId, join(root, 'missing'))).toMatchObject({ registry: false, goal: false, state: 0 });
});

test('only finished or stopped final responses on the current branch can be branched from', async () => {
  const source = await sourceChat();
  const sessionId = modules.database.reserve(root);
  const request = { root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3' };
  await expect(modules.history.publishBranchHistory({ ...request, entryId: 'a2' })).rejects.toThrow(/finished or stopped final response/);
  await expect(modules.history.publishBranchHistory({ ...request, entryId: 'a1', leafId: 'u1' })).rejects.toThrow(/not on the current branch/);
  expect(registered(sessionId)).toBeNull();
});

test('discarding refuses a conversation that is not a branch', async () => {
  const source = await sourceChat();
  await expect(modules.history.discardBranchHistory(root, source.id, source.path)).rejects.toThrow(/not this branch/);
  expect(existsSync(source.path)).toBe(true);
  expect(registered(source.id)).toBe(source.path);
});

test('a goal file stays while a goal row has its objective, comes back when missing, and goes with the last chat that has it', async () => {
  // No other chat of this file has this objective.
  const objective = randomUUID() + OBJECTIVE;
  const source = await sourceChat(objective);
  const sessionId = modules.database.reserve(root);
  const branch = await modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId, cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' });
  const text = modules.goalFiles.agentText(root, objective);
  const file = /^Read the goal objective file at (\S+) before continuing\.$/.exec(text)![1];
  expect(file.startsWith(join(root, 'goal-files') + '/')).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(objective);
  expect(modules.goalFiles.agentText(root, 'Short')).toBe('Short');

  expect(await deleteChat(source.path)).toEqual({});
  expect(existsSync(source.path)).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(objective);

  rmSync(file);
  expect(modules.goalFiles.agentText(root, objective)).toBe(text);
  expect(readFileSync(file, 'utf8')).toBe(objective);

  expect(await deleteChat(branch.sessionPath)).toEqual({});
  expect(existsSync(file)).toBe(false);
});

for (const kind of ['subagent', 'review', 'btw']) test(`worktree history rejects a ${kind} chat even outside the selected history`, async () => {
  const source = await sourceChat();
  const body = readFileSync(source.path, 'utf8');
  source.entries.push({ type: 'custom', id: 'parent-marker', parentId: null, timestamp: new Date().toISOString(), customType: 'piop-auxiliary-parent', data: { kind, parentSessionId: 'parent' } } as any);
  await expect(modules.history.publishBranchHistory({ root, sourcePath: source.path, sessionId: modules.database.reserve(root), cwd: source.cwd, entries: source.entries, leafId: 'a3', entryId: 'a1' })).rejects.toThrow('Only main chats can be forked');
  expect(readFileSync(source.path, 'utf8')).toBe(body);
});
