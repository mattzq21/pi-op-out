import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProjectRepository, refreshProjectRepository } from '../../daemon/src/project_repositories';

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
