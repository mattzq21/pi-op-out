import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileAgentFixture } from '../compile-defined-agent-fixture.mjs';

const settings = createRequire(import.meta.url)('../../daemon/resources/session-database/records.ts');

function assertDatabaseLocked(file) {
  const result = spawnSync('python3', ['-c', `import fcntl,sys
with open(sys.argv[1], 'r+b') as f:
 try: fcntl.lockf(f, fcntl.LOCK_EX|fcntl.LOCK_NB, 510, 1073741826)
 except BlockingIOError: sys.exit(0)
 sys.exit(1)
`, file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'Another process can take the database lock while SQLite still uses it');
}

for (const kind of ['settings', 'agent definitions', 'prompt snapshot']) {
  test(`${kind} writes preserve other connections' locks on the shared session database`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'piop-db-lock-'));
    const file = join(root, 'sessions.sqlite');
    const previous = process.env.PIOP_STORAGE_ROOT, previousTest = process.env.PIOP_TEST_STORAGE_ROOT;
    let db;
    try {
      let publish = () => settings.save(root, 'settings', '{}');
      if (kind !== 'settings') {
        await compileAgentFixture(root);
        process.env.PIOP_STORAGE_ROOT = root; process.env.PIOP_TEST_STORAGE_ROOT = root;
        const prompts = await import(pathToFileURL(join(root, 'prompts.mjs')).href);
        publish = kind === 'agent definitions'
          ? () => prompts.writeConfig({ agents: [] }, true)
          : () => prompts.snapshotPrompt('Lock preservation test');
      }
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(id); INSERT INTO sample VALUES(1); BEGIN; SELECT * FROM sample;');
      assertDatabaseLocked(file);
      await publish();
      assertDatabaseLocked(file);
      assert.equal(db.prepare('SELECT count(*) AS count FROM sample').get().count, 1);
    } finally {
      if (previous === undefined) delete process.env.PIOP_STORAGE_ROOT;
      else process.env.PIOP_STORAGE_ROOT = previous;
      if (previousTest === undefined) delete process.env.PIOP_TEST_STORAGE_ROOT;
      else process.env.PIOP_TEST_STORAGE_ROOT = previousTest;
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${kind} writes refuse a database symlink`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'piop-db-link-'));
    const previous = process.env.PIOP_STORAGE_ROOT, previousTest = process.env.PIOP_TEST_STORAGE_ROOT;
    try {
      fs.writeFileSync(join(root, 'target'), 'untouched');
      fs.symlinkSync(join(root, 'target'), join(root, 'sessions.sqlite'));
      let publish = () => settings.save(root, 'settings', '{}');
      if (kind !== 'settings') {
        await compileAgentFixture(root);
        process.env.PIOP_STORAGE_ROOT = root; process.env.PIOP_TEST_STORAGE_ROOT = root;
        const prompts = await import(pathToFileURL(join(root, 'prompts.mjs')).href);
        publish = kind === 'agent definitions'
          ? () => prompts.writeConfig({ agents: [] }, true)
          : () => prompts.snapshotPrompt('Lock preservation test');
      }
      await assert.rejects(async () => publish(), /symbolic link|ELOOP/);
      assert.equal(fs.readFileSync(join(root, 'target'), 'utf8'), 'untouched');
    } finally {
      if (previous === undefined) delete process.env.PIOP_STORAGE_ROOT;
      else process.env.PIOP_STORAGE_ROOT = previous;
      if (previousTest === undefined) delete process.env.PIOP_TEST_STORAGE_ROOT;
      else process.env.PIOP_TEST_STORAGE_ROOT = previousTest;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
