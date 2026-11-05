import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { temporaryChat } = createRequire(import.meta.url)('../../daemon/resources/temporary-chat.ts');

test('a no-project chat folder is the shortest free start of the chat ID, kept on retry, and removed by its path', t => {
  const root = mkdtempSync(join(tmpdir(), 'piop-temporary-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  mkdirSync(join(root, 'tmp', '3fa8'), { recursive: true });
  const folder = temporaryChat({ action: 'create', id, root });
  assert.equal(folder, join(root, 'tmp', '3fa85'));
  assert.equal(temporaryChat({ action: 'create', id, root }), folder, 'a retry keeps the saved folder');
  assert.equal(temporaryChat({ action: 'remove', path: folder, root }), null);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(join(root, 'tmp', '3fa8')), true, 'the folder of another name is untouched');
});
