import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';
import { startHost, type TestHost } from './host-fixture';

test('ended archive leases and completed deletes cannot authorize terminal reassignment', async () => {
  const daemon = await startDaemon();
  let host: TestHost | undefined;
  try {
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ home: daemon.home, content: '' }),
    }));
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: chat.path, terminalIds: [], clientId: 'archive-setup' });
    const report = await daemon.invoke('storage_report');
    const archived = report.hosts.find((value: any) => value.hostId === 'local').archives.find((value: any) => value.id === chat.id);
    expect(archived).toBeDefined();
    await daemon.stop();
    host = await startHost({ home: daemon.home });
    const fixture = host;
    const owner = (clientId = 'archive-owner', allowReleased = true) => fixture.call('conversationOwner', archived.id, clientId, allowReleased);
    const mutation = { sessionId: archived.id, sessionPath: archived.path, clientId: 'archive-owner', archived: true, operation: 'delete' };
    const lease = await host.call('beginMutation', mutation);
    expect(await owner()).toBe(true);
    await host.call('endMutation', { token: lease.token, success: false });
    expect(await owner()).toBe(false);
    expect(await owner('archive-owner', false)).toBe(false);
    const next = await host.call('beginMutation', { ...mutation, clientId: 'next-owner' });
    expect(await owner('next-owner')).toBe(true);
    await host.call('endMutation', { token: next.token, success: true });
    expect(await owner('next-owner')).toBe(false);
    expect(await owner()).toBe(false);
  } finally { await host?.stop(); await daemon.stop(); }
});
