import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import database from '../../daemon/resources/session-database.cjs';
import { persistSubagentRun, savedSubagentRuns } from '../../daemon/resources/piop-storage/subagent-results.ts';

test('subagent status updates use one SQL row with the current task', t => {
  const root = mkdtempSync(join(tmpdir(), 'piop-run-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sessions'));
  const parent = database.reserve(root), child = database.reserve(root);
  const file = join(root, 'sessions', 'parent.jsonl'), childFile = join(root, 'sessions', 'child.jsonl');
  const db = database.open(root);
  database.bind(db, parent, file);
  database.bind(db, child, childFile);
  const ctx = { sessionManager: { getSessionFile: () => file, getSessionId: () => parent } };
  const run = { version: 1, toolCallId: 'call', parentSessionId: parent, sessionId: child, sessionPath: childFile, hostId: 'local', name: 'Worker', task: 'Original task', status: 'running', startedAt: 1 };
  persistSubagentRun(ctx, run);
  persistSubagentRun(ctx, { ...run, task: 'Resolved task text', status: 'completed', output: 'Done' });
  persistSubagentRun(ctx, run);
  const saved = savedSubagentRuns(ctx);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'completed');
  assert.equal(saved[0].task, 'Resolved task text');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_extension_records').get().n, 0);
  db.close();
});
