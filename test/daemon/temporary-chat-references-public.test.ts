import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './harness';

test.concurrent('temporary folder cleanup keeps a referenced directory until the saved chat moves away', async () => {
  const daemon = await startDaemon();
  try {
    const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const saved = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: temporary.cwd, content: JSON.stringify({
        type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Keep this working folder', timestamp: 1 },
      }) + '\n' }),
    }));
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toBe(temporary.cwd);
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === saved.id))
      .toMatchObject({ cwd: temporary.cwd, cwdExists: true, preview: 'Keep this working folder' });

    await daemon.invoke('relocate_session', { sessionPath: saved.path, cwd: daemon.home, hostId: 'local', clientId: 'folder-reference-test' });
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.failure('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toContain('is unavailable');
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === saved.id))
      .toMatchObject({ cwd: daemon.home, cwdExists: true, preview: 'Keep this working folder' });
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('closing an unused temporary chat keeps files of a saved chat working in its subfolder', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'unused-temporary';
  try {
    const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const project = join(temporary.cwd, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'notes.txt'), 'saved work');
    const saved = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: project, content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Saved work', timestamp: 1 } }) + '\n' }),
    }));
    await daemon.invoke('start_pi', { runtimeId, clientId: 'temporary-client', cwd: temporary.cwd, sessionId: temporary.sessionId });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('saved work');
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === saved.id))
      .toMatchObject({ cwd: project, cwdExists: true });
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('closing an unused temporary chat keeps the subfolder of an archived chat restorable', async () => {
  const daemon = await startDaemon();
  const runtimeId = 'unused-temporary-archived';
  try {
    const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const project = join(temporary.cwd, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'notes.txt'), 'archived work');
    const saved = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: project, content: JSON.stringify({
        type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Archived in a temporary folder', timestamp: 1 },
      }) + '\n' }),
    }));
    await daemon.invoke('archive_session', { hostId: 'local', sessionPath: saved.path, terminalIds: [], clientId: 'archived-reference-test' });
    await daemon.invoke('start_pi', { runtimeId, clientId: 'temporary-client', cwd: temporary.cwd, sessionId: temporary.sessionId });
    await daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId
      && packet.event?.type === 'settings_pending' && packet.event.pending === false);
    expect(await daemon.invoke('stop_pi', { runtimeId, discardBlank: true })).toBe(true);
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('archived work');

    const report = (await daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local');
    expect(report.warnings.some((line: string) => line.includes('Temporary folder cleanup'))).toBe(false);
    const archives = report.archives;
    await daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archives.find((row: any) => row.id === saved.id).path, clientId: 'archived-reference-test' });
    expect((await daemon.invoke('list_sessions')).find((row: any) => row.id === saved.id))
      .toMatchObject({ cwd: project, cwdExists: true, preview: 'Archived in a temporary folder' });
    const reader = 'archived-reference-reader';
    await daemon.invoke('start_pi', { runtimeId: reader, clientId: 'archived-reference-test', sessionPath: saved.path, cwd: project, presence: { readOnly: true } });
    try {
      expect((await daemon.invoke('pi_command', { runtimeId: reader, command: { type: 'get_entries' } })).entries)
        .toMatchObject([{ id: 'question', message: { role: 'user', content: 'Archived in a temporary folder' } }]);
    } finally { await daemon.invoke('stop_pi', { runtimeId: reader }); }
    await daemon.invoke('delete_session', { hostId: 'local', sessionPath: saved.path, clientId: 'archived-reference-test' });
    expect(existsSync(temporary.cwd)).toBe(false);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('temporary folder cleanup waits for a damaged chat header to be repaired', async () => {
  const daemon = await startDaemon();
  try {
    const temporary = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const saved = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home: daemon.home, cwd: daemon.home, content: JSON.stringify({ type: 'message', id: 'request', parentId: null, message: { role: 'user', content: 'Saved work', timestamp: 1 } }) + '\n' }),
    }));
    const original = readFileSync(saved.path, 'utf8');
    writeFileSync(saved.path, 'damaged header\n');
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toBe(temporary.cwd);

    writeFileSync(saved.path, original);
    await daemon.invoke('remove_temporary_chat', { hostId: 'local', path: temporary.cwd });
    expect(await daemon.failure('validate_project_directory', { hostId: 'local', path: temporary.cwd, allowStorage: true }))
      .toContain('is unavailable');
  } finally { await daemon.stop(); }
}, 60_000);
