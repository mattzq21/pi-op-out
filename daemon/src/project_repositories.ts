import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import * as Registry from './session_registry';

const run = promisify(execFile);
export interface ProjectRepository { root: string; gitDir: string }

function database(storageRoot: string) {
  const db = Registry.open(storageRoot);
  db.exec('CREATE TABLE IF NOT EXISTS project_repositories (cwd TEXT PRIMARY KEY, repository TEXT)');
  return db;
}

export function getProjectRepository(storageRoot: string, cwd: string): ProjectRepository | null {
  const db = database(storageRoot);
  try {
    const row = db.prepare('SELECT repository FROM project_repositories WHERE cwd=?').get(resolve(cwd)) as { repository: string | null } | undefined;
    return row?.repository ? JSON.parse(row.repository) : null;
  } finally { db.close(); }
}

export function rememberProjectRepository(storageRoot: string, cwd: string, repository: ProjectRepository | null): void {
  const db = database(storageRoot);
  try { db.prepare('INSERT INTO project_repositories(cwd, repository) VALUES (?, ?) ON CONFLICT(cwd) DO UPDATE SET repository=excluded.repository').run(resolve(cwd), repository ? JSON.stringify(repository) : null); }
  finally { db.close(); }
}

export async function refreshProjectRepository(storageRoot: string, cwd: string): Promise<ProjectRepository | null> {
  let repository: ProjectRepository | null;
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const [root, gitDir] = stdout.trimEnd().split('\n');
    if (!root || !gitDir) throw new Error('Git returned an invalid repository location');
    repository = { root, gitDir };
  } catch (error: any) {
    if (!String(error.stderr ?? '').includes('not a git repository')) throw error;
    repository = null;
  }
  rememberProjectRepository(storageRoot, cwd, repository);
  return repository;
}
