import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgetProjectRepository, rememberProjectRepository, getProjectRepository, refreshProjectRepository } from '../../daemon/src/project_repositories';

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

test('repository detection from a project subdirectory stores the repository root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'piop-project-git-'));
  const project = join(directory, 'project');
  mkdirSync(join(project, 'sub'), { recursive: true });
  try {
    execFileSync('git', ['init', project], { stdio: 'ignore' });
    expect((await refreshProjectRepository(join(directory, 'profile'), join(project, 'sub')))?.root).toBe(project);
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


test('forgetting a worktree clears its project subfolders without affecting adjacent folders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'piop-project-forget-'));
  const root = join(directory, 'profile');
  const worktree = join(directory, 'worktree');
  const nested = join(worktree, 'apps/web');
  const adjacent = worktree + '-other';
  const repository = { root: worktree, gitDir: join(directory, '.git') };
  try {
    for (const cwd of [worktree, nested, adjacent]) rememberProjectRepository(root, cwd, repository);
    forgetProjectRepository(root, worktree);
    expect(getProjectRepository(root, worktree)).toBeNull();
    expect(getProjectRepository(root, nested)).toBeNull();
    expect(getProjectRepository(root, adjacent)).toEqual(repository);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
