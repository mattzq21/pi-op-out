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
    const owner = { type: 'conversation_owner', sessionId: archived.id, clientId: 'archive-owner', allowReleased: true };
    const mutation = { type: 'conversation_mutation', sessionId: archived.id, sessionPath: archived.path,
      clientId: 'archive-owner', archived: true, operation: 'delete' };
    const lease = await host.request(mutation);
    expect(await host.request(owner)).toBe(true);
    // Abandoning an archive mutation must release its owner as well as its locks.
    await host.request({ type: 'conversation_mutation_end', token: lease.token, success: false });
    expect(await host.request(owner)).toBe(false);
    expect(await host.request({ ...owner, allowReleased: false })).toBe(false);
    const next = await host.request({ ...mutation, clientId: 'next-owner' });
    expect(await host.request({ ...owner, clientId: 'next-owner' })).toBe(true);
    await host.request({ type: 'conversation_mutation_end', token: next.token, success: true });
    expect(await host.request({ ...owner, clientId: 'next-owner' })).toBe(false);
    expect(await host.request(owner)).toBe(false);
  } finally { await host?.stop(); await daemon.stop(); }
});
