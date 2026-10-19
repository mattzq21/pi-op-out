import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test('closed chat views restore SQL state and change revision without a transcript write', async () => {
  const daemon = await startDaemon();
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home: daemon.home, content: '' }) }));
    const body = readFileSync(chat.path, 'utf8');
    const entries = body.trim().split('\n').map(JSON.parse);
    const after = entries.findLast(entry => entry.type !== 'session')?.id ?? null;
    const db = new Database(join(daemon.home, '.piop', 'sessions.sqlite'));
    try {
      const paused = { type: 'custom', id: crypto.randomUUID(), parentId: after, timestamp: new Date().toISOString(), customType: 'pi-desktop-pause-state', data: { isPaused: true } };
      const insert = db.query('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)');
      insert.run(chat.id, paused.id, after, JSON.stringify(paused));
      const runtimeId = crypto.randomUUID();
      await daemon.invoke('start_pi', { runtimeId, clientId: 'saved-state-reader', cwd: daemon.home, sessionPath: chat.path, presence: { readOnly: true } });
      const command = (type: string) => daemon.invoke('pi_command', { runtimeId, command: { type } });
      const first = await command('get_snapshot');
      expect(first.state.isPaused).toBe(true);
      expect(first.history.entries.at(-1)).toEqual(paused);
      const resumed = { ...paused, id: crypto.randomUUID(), parentId: paused.id, data: { isPaused: false } };
      insert.run(chat.id, resumed.id, after, JSON.stringify(resumed));
      const second = await command('get_snapshot');
      expect(second.state.isPaused).toBe(false);
      expect(second.revision).not.toBe(first.revision);
      expect((await command('get_session_revision')).revision).toBe(second.revision);
      expect(readFileSync(chat.path, 'utf8')).toBe(body);
      await daemon.invoke('stop_pi', { runtimeId });
    } finally { db.close(); }
  } finally { await daemon.stop(); }
}, 60000);
