import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test.concurrent('opening a chat preserves a file that blocks an extension folder and can retry after it is removed', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const obstruction = join(daemon.home, '.piop/piop-context-window-cap');
    rmSync(obstruction, { recursive: true, force: true });
    writeFileSync(obstruction, 'keep');
    const request = { runtimeId: crypto.randomUUID(), clientId: 'extension-obstruction', cwd: daemon.home, sessionPath: chat.path };
    const failure = await daemon.failure('start_pi', request);
    expect(failure).toContain('EEXIST');
    expect(failure).toContain(obstruction);
    expect(readFileSync(obstruction, 'utf8')).toBe('keep');

    rmSync(obstruction);
    expect(await daemon.invoke('start_pi', request)).toMatchObject({ owned: true });
    await daemon.invoke('stop_pi', { runtimeId: request.runtimeId });
  } finally { await daemon.stop(); }
}, 60000);

test.concurrent('opening a chat preserves directories that block extension files and can retry after they are removed', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', input: JSON.stringify({ home: daemon.home, content: '' }), timeout: 30000,
    }));
    const request = { runtimeId: crypto.randomUUID(), clientId: 'extension-obstruction', cwd: daemon.home, sessionPath: chat.path };
    const generated = join(daemon.home, '.piop');
    for (const name of ['piop-mcp-bridge.ts', 'session-broker.ts', 'piop-openai-cache-fork.ts', 'piop-codex-web-search.ts']) {
      const obstruction = join(generated, name);
      rmSync(obstruction, { force: true });
      mkdirSync(obstruction, { mode: 0o750 });
      writeFileSync(join(obstruction, 'keep'), 'original directory');
      const originalMode = statSync(obstruction).mode & 0o777;
      try {
        const failure = await daemon.failure('start_pi', request);
        expect(failure).toContain('Configuration path is a directory');
        expect(failure).toContain(obstruction);
        expect(readFileSync(join(obstruction, 'keep'), 'utf8')).toBe('original directory');
        expect(statSync(obstruction).mode & 0o777).toBe(originalMode);
        expect(readdirSync(obstruction)).toEqual(['keep']);
        expect(readdirSync(generated).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
      } finally { rmSync(obstruction, { recursive: true }); }
    }

    expect(await daemon.invoke('start_pi', request)).toMatchObject({ owned: true });
    await daemon.invoke('stop_pi', { runtimeId: request.runtimeId });
  } finally { await daemon.stop(); }
}, 60000);
