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
    const db = new Database(join(daemon.home, '.piop', 'sessions.sqlite'));
    try {
      const paused = { type: 'custom', id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), customType: 'pi-desktop-pause-state', data: { isPaused: true } };
      const insert = db.query('INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?) ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json');
      insert.run(chat.id, paused.customType, JSON.stringify(paused));
      const count = () => (db.query('SELECT count(*) AS n FROM session_extension_state WHERE session_id=?').get(chat.id) as { n: number }).n;
      const originalCount = count();
      const runtimeId = crypto.randomUUID();
      await daemon.invoke('start_pi', { runtimeId, clientId: 'saved-state-reader', cwd: daemon.home, sessionPath: chat.path, presence: { readOnly: true } });
      const command = (type: string) => daemon.invoke('pi_command', { runtimeId, command: { type } });
      const first = await command('get_snapshot');
      expect(first.state.isPaused).toBe(true);
      expect(first.history.entries.some((entry: any) => entry.customType === paused.customType)).toBe(false);
      const resumed = { ...paused, id: crypto.randomUUID(), parentId: null, data: { isPaused: false } };
      insert.run(chat.id, resumed.customType, JSON.stringify(resumed));
      const second = await command('get_snapshot');
      expect(second.state.isPaused).toBe(false);
      expect(count()).toBe(originalCount);
      expect(second.revision).not.toBe(first.revision);
      expect((await command('get_session_revision')).revision).toBe(second.revision);
      expect(readFileSync(chat.path, 'utf8')).toBe(body);
      await daemon.invoke('stop_pi', { runtimeId });
    } finally { db.close(); }
  } finally { await daemon.stop(); }
}, 60000);
