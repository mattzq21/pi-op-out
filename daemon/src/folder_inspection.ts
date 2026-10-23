import { runLimited, type CommandSpec } from './process_io';
import type { SessionSummary } from './types';

/** Prints one digit per folder: 0 missing, 1 present, 2 a linked Git worktree (its .git is a file). */
const SCRIPT = `for path do
        if [ -d "$path" ] && [ -f "$path/.git" ]; then printf '2'; elif [ -d "$path" ]; then printf '1'; else printf '0'; fi
    done`;

export async function inspectSessionProjectsWith(sessions: SessionSummary[], command: (script: string, batch: string[]) => CommandSpec): Promise<void> {
  const directories = [...new Set(sessions.map(session => session.cwd))].sort();
  const folders = new Map<string, number>();
  for (let index = 0; index < directories.length; index += 16) {
    const batch = directories.slice(index, index + 16);
    const output = await runLimited(command(SCRIPT, batch), batch.length, 'Could not check session folders');
    if (!output.status.success) throw new Error(`Could not check session folders: ${output.stderr.toString().trim()}`);
    if (output.stdout.length !== batch.length || [...output.stdout].some(flag => flag < 0x30 || flag > 0x32)) throw new Error('Could not check every session folder');
    batch.forEach((path, position) => folders.set(path, output.stdout[position] - 0x30));
  }
  for (const session of sessions) {
    const state = folders.get(session.cwd);
    if (state === undefined) continue;
    session.cwdExists = state > 0;
    session.linkedWorktree = state === 2;
  }
}
