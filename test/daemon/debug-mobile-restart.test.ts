import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { daemonDirectory, startDaemon, temporaryDirectory } from './harness';

test('debug Android keeps its address and token through a daemon restart', async () => {
  const home = temporaryDirectory();
  const options = { home, development: true, projectRoot: process.cwd() };
  const read = () => {
    const db = new Database(join(daemonDirectory(home, options), 'sessions.sqlite'), { readonly: true });
    try { return JSON.parse(Buffer.from((db.query("SELECT body FROM application_settings WHERE name='debug-mobile.json'").get() as any).body).toString()); }
    finally { db.close(); }
  };
  const first = await startDaemon(options);
  const before = read();
  await first.stop();
  const second = await startDaemon(options);
  try {
    const after = read();
    expect(after.url === before.url).toBe(true);
    expect(after.token === before.token).toBe(true);
    const ws = new WebSocket(before.url);
    const ready = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', token: before.token }));
      ws.onmessage = event => resolve(JSON.parse(String(event.data)));
      ws.onerror = reject;
    });
    ws.close();
    expect(ready.type).toBe('ready');
  } finally { await second.stop(); }
}, 60_000);
