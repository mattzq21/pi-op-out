import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSessionProjectsWith } from '../../daemon/src/folder_inspection';
import type { SessionSummary } from '../../daemon/src/types';

const session = (cwd: string) => ({ id: cwd, cwd, cwdExists: true } as SessionSummary);

test('the folder check marks a linked Git worktree, and a main worktree or missing folder is not one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'piop-folders-'));
  const main = join(root, 'main'); const linked = join(root, 'linked'); const missing = join(root, 'missing');
  mkdirSync(join(main, '.git'), { recursive: true });
  mkdirSync(linked); writeFileSync(join(linked, '.git'), 'gitdir: ' + join(main, '.git', 'worktrees', 'linked'));
  const sessions = [session(main), session(linked), session(missing)];
  await inspectSessionProjectsWith(sessions, (script, batch) => ({ program: 'sh', args: ['-c', script, 'sh', ...batch] }));
  expect(sessions.map(item => [item.cwdExists, item.linkedWorktree])).toEqual([[true, false], [true, true], [false, false]]);
});
