import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rememberProjectRepository, getProjectRepository, refreshProjectRepository } from '../../daemon/src/project_repositories';

test('repository status changes only on an explicit project or new-chat check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'piop-project-git-'));
  const root = join(directory, 'profile');
  const project = join(directory, 'project');
  mkdirSync(project);
  try {
    expect(await refreshProjectRepository(root, project)).toBeNull();
    execFileSync('git', ['init', project], { stdio: 'ignore' });
    expect(getProjectRepository(root, project)).toBeNull();
    const repository = await refreshProjectRepository(root, project);
    expect(repository?.root).toBe(project);
    expect(repository?.gitDir).toBe(join(project, '.git'));
    rmSync(join(project, '.git'), { recursive: true });
    expect(getProjectRepository(root, project)).toEqual(repository);
    expect(await refreshProjectRepository(root, project)).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('repository subfolders are normal folders, including previously cached subfolders', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'piop-project-git-'));
  const project = join(directory, 'project');
  mkdirSync(join(project, 'sub'), { recursive: true });
  try {
    execFileSync('git', ['init', project], { stdio: 'ignore' });
    const root = join(directory, 'profile');
    const subfolder = join(project, 'sub');
    rememberProjectRepository(root, subfolder, { root: project, gitDir: join(project, '.git') });
    expect(getProjectRepository(root, subfolder)).toBeNull();
    expect(await refreshProjectRepository(root, subfolder)).toBeNull();
    expect(getProjectRepository(root, subfolder)).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new draft chat rechecks the project but reopening it does not', async () => {
  const { startDaemon } = await import('./harness');
  const daemon = await startDaemon();
  const project = join(daemon.home, 'project');
  mkdirSync(project);
  try {
    await daemon.invoke('validate_project_directory', { path: project, hostId: 'local', allowStorage: true, newChat: true });
    expect(getProjectRepository(join(daemon.home, '.piop'), project)).toBeNull();
    execFileSync('git', ['init', project], { stdio: 'ignore' });
    await daemon.invoke('validate_project_directory', { path: project, hostId: 'local', allowStorage: true });
    expect(getProjectRepository(join(daemon.home, '.piop'), project)).toBeNull();
    await daemon.invoke('validate_project_directory', { path: project, hostId: 'local', allowStorage: true, newChat: true });
    expect(getProjectRepository(join(daemon.home, '.piop'), project)?.root).toBe(project);
  } finally { await daemon.dispose(); }
}, 60000);
