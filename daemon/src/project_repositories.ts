import { detectRepository } from './chat_worktrees';
import { resolve } from 'node:path';
import * as Registry from './session_registry';

export interface ProjectRepository { root: string; gitDir: string }

function database(storageRoot: string) {
  return Registry.connection(storageRoot);
}

export function getProjectRepository(storageRoot: string, cwd: string): ProjectRepository | null {
  const db = database(storageRoot);
  const row = db.prepare('SELECT repository FROM project_repositories WHERE cwd=?').get(resolve(cwd)) as { repository: string | null } | undefined;
  const repository: ProjectRepository | null = row?.repository ? JSON.parse(row.repository) : null;
  return repository && resolve(repository.root) === resolve(cwd) ? repository : null;
}

export function rememberProjectRepository(storageRoot: string, cwd: string, repository: ProjectRepository | null): void {
  const db = database(storageRoot);
  db.prepare('INSERT INTO project_repositories(cwd, repository) VALUES (?, ?) ON CONFLICT(cwd) DO UPDATE SET repository=excluded.repository').run(resolve(cwd), repository ? JSON.stringify(repository) : null);
}

export function forgetProjectRepository(storageRoot: string, cwd: string): void {
  const db = database(storageRoot);
  db.prepare('DELETE FROM project_repositories WHERE cwd=?').run(resolve(cwd));
}

export async function refreshProjectRepository(storageRoot: string, cwd: string): Promise<ProjectRepository | null> {
  const detected = await detectRepository(cwd);
  const repository = detected ? { root: resolve(cwd), gitDir: detected.gitCommonDir } : null;
  rememberProjectRepository(storageRoot, cwd, repository);
  return repository;
}
