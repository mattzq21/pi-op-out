import { detectRepository } from './chat_worktrees';
import { resolve } from 'node:path';
import { projectRepositoryJson, removeProjectRepository, saveProjectRepositoryJson } from '../resources/session-database.cjs';

export interface ProjectRepository { root: string; gitDir: string }

export function getProjectRepository(storageRoot: string, cwd: string): ProjectRepository | null {
  const saved = projectRepositoryJson(storageRoot, resolve(cwd));
  const repository: ProjectRepository | null = saved ? JSON.parse(saved) : null;
  return repository && resolve(repository.root) === resolve(cwd) ? repository : null;
}

export function rememberProjectRepository(storageRoot: string, cwd: string, repository: ProjectRepository | null): void {
  saveProjectRepositoryJson(storageRoot, resolve(cwd), repository ? JSON.stringify(repository) : null);
}

export function forgetProjectRepository(storageRoot: string, cwd: string): void {
  removeProjectRepository(storageRoot, resolve(cwd));
}

export async function refreshProjectRepository(storageRoot: string, cwd: string): Promise<ProjectRepository | null> {
  const detected = await detectRepository(cwd);
  const repository = detected ? { root: resolve(cwd), gitDir: detected.gitCommonDir } : null;
  rememberProjectRepository(storageRoot, cwd, repository);
  return repository;
}
