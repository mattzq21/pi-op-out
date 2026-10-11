import { plugin } from 'bun';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';

plugin({ name: 'raw-text', setup(build) {
  build.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(dirname(args.importer), args.path.slice(0, -4)), namespace: 'raw-text' }));
  build.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ exports: { default: readFileSync(args.path, 'utf8') }, loader: 'object' }));
} });

const storage = await import('../../daemon/src/storage_transactions');
const ownership = await import('../../daemon/src/conversation_storage');
const { STORAGE_DIRECTORY } = await import('../../daemon/src/config');
const root = join(process.env.HOME!, STORAGE_DIRECTORY);
const sessions = join(root, 'sessions');
const host = { kind: 'local' } as const;
mkdirSync(sessions, { recursive: true });

function session(message = true) {
  const id = randomUUID();
  const file = join(sessions, `session-${id}.jsonl`);
  const entries: unknown[] = [{ type: 'session', version: 3, id, cwd: process.env.HOME, timestamp: new Date().toISOString() }];
  if (message) entries.push({ type: 'message', id: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() } });
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  ownership.write(root, createHash('sha256').update(id).digest('hex').slice(0, 40), JSON.stringify({ path: file, deleted: false, client: null }));
  return { id, file };
}

switch (process.argv[2]) {
  case 'archive-restore': {
    const original = session();
    const archive = await storage.archive(host, [original.file]);
    assert.equal(archive.sessions[0].sessionId, original.id);
    const archived = archive.sessions[0].sessionPath;
    assert.equal(existsSync(original.file), false);
    assert.equal(existsSync(archived), true);
    const restored = await storage.restore(host, [archived]);
    assert.equal(restored.sessions[0].sessionPath, original.file);
    assert.equal(existsSync(original.file), true);
    assert.deepEqual(await storage.committedRestore(host, archived), restored);
    await storage.recover(host);
    const records = require('../../daemon/resources/restore-records.cjs');
    const receiptPath = records.list(root, true)[0];
    const receipt = records.read(receiptPath).value;
    delete receipt.result.sessions;
    records.write(receiptPath, JSON.stringify(receipt));
    assert.deepEqual(await storage.committedRestore(host, archived), restored);
    assert.equal(await storage.committedRestore(host, join(root, 'archived', 'absent.jsonl')), null);
    break;
  }
  case 'delete': {
    const original = session();
    const deleted = await storage.deleteSessions(host, [{ path: original.file, area: 'sessions' }], []);
    assert.deepEqual(deleted.sessionIds, [original.id]);
    assert.equal(existsSync(original.file), false);
    break;
  }
  case 'rollback': {
    const original = session();
    const before = readFileSync(original.file);
    await assert.rejects(storage.archive(host, [original.file, join(sessions, 'absent.jsonl')]), error => {
      assert.ok(error instanceof storage.StorageTransactionError);
      assert.equal(error.state, 'rolled-back');
      return true;
    });
    assert.deepEqual(readFileSync(original.file), before);
    const io = require('../../daemon/resources/session-transactions.cjs');
    const database = require('../../daemon/resources/session-database.cjs').open(root);
    const id = randomUUID();
    const staging = join(root, 'storage-transactions', id);
    const staged = join(staging, '0.staged');
    const identity = io.describe(original.file);
    const journal = { version: 1, id, kind: 'delete', state: 'prepared', root, staging,
      targets: [{ path: original.file, sessionId: original.id }],
      steps: [{ type: 'move', source: original.file, staged, identity, applied: true }], finish: [] };
    database.prepare('INSERT INTO storage_transactions VALUES (?, ?, ?, ?)').run(id, journal.kind, journal.state, JSON.stringify(journal));
    database.close();
    mkdirSync(staging, { recursive: true });
    renameSync(original.file, staged);
    const { desktopSessionFile } = await import('../../daemon/src/archives');
    assert.equal(await desktopSessionFile({} as any, 'local', original.file), original.file);
    assert.deepEqual(readFileSync(original.file), before);
    break;
  }
  case 'busy': {
    const holder = spawn('flock', ['--exclusive', join(root, 'session-transactions.lock'), 'sh', '-c', 'printf ready; read release'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await once(holder.stdout, 'data');
      await storage.recover(host, { busyIsOk: true });
      await assert.rejects(storage.recover(host, { busyIsOk: false }), /busy/i);
      const original = session();
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(storage.recover(host, { signal: controller.signal, busyIsOk: true }), /abort/i);
      assert.equal(existsSync(original.file), true);
    } finally {
      const closed = once(holder, 'close');
      holder.stdin.end('release\n');
      await closed;
    }
    break;
  }
  case 'blank': {
    await storage.deleteBlank(host, { path: join(sessions, 'missing.jsonl') });
    const blank = session(false);
    await storage.deleteBlank(host, { path: blank.file, id: blank.id });
    assert.equal(existsSync(blank.file), false);
    const submitted = session();
    await storage.deleteBlank(host, { path: submitted.file, id: submitted.id });
    assert.equal(existsSync(submitted.file), true);
    break;
  }
  default: throw new Error('Unknown storage test');
}
