import { STORAGE_DIRECTORY } from './config';
import { storageTransactionBundle } from './resources';
import { nodeCommand } from './node_command';
import { remoteHost, remoteLoginCommand, ssh } from './pi_launch';
import { runLimited, shellQuote, type CommandSpec, type Output } from './process_io';
import { loadAppSettings } from './settings';
import type { AppSettings } from './settings_types';
import type { App } from './app';

export async function archiveConversations(app: App, hostId: string, paths: string[]): Promise<void> {
  const invalidate = app.sessionIndex.projects.invalidateAfter(hostId);
  try {
    const settings = await loadAppSettings(app);
    await archiveCommand(settings, hostId, { action: 'archive', paths });
  } finally { invalidate(); }
}

async function archiveCommand(settings: AppSettings, hostId: string, request: unknown): Promise<Output> {
  const argumentsText = JSON.stringify(request);
  const command: CommandSpec = hostId === 'local'
    ? nodeCommand(['-e', storageTransactionBundle, argumentsText])
    : ssh(remoteHost(settings, hostId), remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(storageTransactionBundle)} ${shellQuote(argumentsText)}`));
  const result = await runLimited(command, 64 * 1024, 'Could not archive conversations');
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  if (result.stderr.length) console.error(result.stderr.toString().trim());
  return result;
}
