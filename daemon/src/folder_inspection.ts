import { runLimited, type CommandSpec } from './process_io';
import type { SessionSummary } from './types';

const SCRIPT = `for path do
        if [ -d "$path" ]; then printf '1'; else printf '0'; fi
    done`;

export async function inspectSessionProjectsWith(sessions: SessionSummary[], command: (script: string, batch: string[]) => CommandSpec): Promise<void> {
  const directories = [...new Set(sessions.map(session => session.cwd))].sort();
  const folders = new Map<string, boolean>();
  for (let index = 0; index < directories.length; index += 16) {
    const batch = directories.slice(index, index + 16);
    const output = await runLimited(command(SCRIPT, batch), batch.length, 'Could not check session folders');
    if (!output.status.success) throw new Error(`Could not check session folders: ${output.stderr.toString().trim()}`);
    if (output.stdout.length !== batch.length || [...output.stdout].some(flag => flag !== 0x30 && flag !== 0x31)) throw new Error('Could not check every session folder');
    batch.forEach((path, position) => folders.set(path, output.stdout[position] === 0x31));
  }
  for (const session of sessions) {
    const exists = folders.get(session.cwd);
    if (exists !== undefined) session.cwdExists = exists;
  }
}
