import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.stop(); });

function publishChat(): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000, input: JSON.stringify({ home: daemon.home, content: '' }),
  }));
}

function noteEditor(clientId: string, sessionId: string) {
  const leaseId = crypto.randomUUID();
  let leaseToken: string | undefined;
  const call = async (action: string, fields: Record<string, string> = {}) => {
    const result = await daemon.invoke('plugin_call', { clientId, pluginId: 'markdown', request: { sessionId, leaseId, action, ...(leaseToken ? { leaseToken } : {}), ...fields } });
    if (result.ownership?.token) leaseToken = result.ownership.token;
    return result;
  };
  return { call, save: (content: string, version: string) => call('save', { content, version }) };
}

test('the editor holding a chat note saves it while other clients can only read it', async () => {
  const { id: sessionId } = publishChat();
  const laptop = noteEditor('laptop', sessionId);
  const phone = noteEditor('phone', sessionId);
  const claimed = await laptop.call('claim');
  expect(claimed).toMatchObject({ content: '', ownership: { owned: true, available: false } });
  await laptop.save('# Plan\n- ship it', claimed.version);
  const read = await phone.call('claim');
  expect(read).toMatchObject({ content: '# Plan\n- ship it', ownership: { owned: false, available: false, token: null } });
  expect(await phone.save('overwrite', read.version).then(() => 'saved', (error: Error) => error.message)).toBe('This client no longer controls the note.');
  expect((await laptop.call('read')).content).toBe('# Plan\n- ship it');
}, 60000);

const failure = (promise: Promise<unknown>) => promise.then(() => 'saved', (error: Error) => error.message);

test('taking over a note stops the previous editor and refuses saves based on an older copy', async () => {
  const { id: sessionId } = publishChat();
  const laptop = noteEditor('laptop', sessionId);
  const phone = noteEditor('phone', sessionId);
  const laptopCopy = await laptop.call('claim');
  const taken = await phone.call('takeover');
  expect(taken.ownership).toMatchObject({ owned: true });
  await phone.save('phone edit', taken.version);
  expect(await failure(laptop.save('laptop edit', laptopCopy.version))).toBe('This client no longer controls the note.');
  await laptop.call('takeover');
  expect(await failure(laptop.save('laptop edit', laptopCopy.version))).toBe('This chat\u2019s note changed. Load it again before saving.');
  expect((await laptop.call('read')).content).toBe('phone edit');
}, 60000);

test('a released note becomes free for the next editor, even another window on the same client', async () => {
  const { id: sessionId } = publishChat();
  const firstWindow = noteEditor('laptop', sessionId);
  const secondWindow = noteEditor('laptop', sessionId);
  await firstWindow.call('claim');
  expect((await secondWindow.call('claim')).ownership).toEqual({ owned: false, available: false, token: null });
  expect((await firstWindow.call('release')).ownership).toEqual({ owned: false, available: true, token: null });
  const claimed = await secondWindow.call('claim');
  expect(claimed.ownership).toMatchObject({ owned: true, available: false });
  await secondWindow.save('from the second window', claimed.version);
  expect((await firstWindow.call('read')).content).toBe('from the second window');
}, 60000);

test('saving a note tells other clients, and a deleted chat answers every note request as deleted', async () => {
  const chat = publishChat();
  const viewer = await daemon.connect();
  try {
    const editor = noteEditor('laptop', chat.id);
    const claimed = await editor.call('claim');
    await editor.save('keep this', claimed.version);
    await viewer.waitEvent('pi://event', event => event.type === 'note_changed' && event.sessionId === chat.id);
    await daemon.invoke('delete_session', { sessionPath: chat.path, hostId: 'local', clientId: 'laptop' });
    expect(await editor.call('read')).toMatchObject({ content: '', deleted: true, ownership: { owned: false, available: false } });
    expect(await editor.save('too late', claimed.version)).toMatchObject({ content: '', deleted: true });
    expect((await noteEditor('phone', chat.id).call('read')).content).toBe('');
  } finally { viewer.close(); }
}, 60000);
