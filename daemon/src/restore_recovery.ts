import { storageTransactionBundle } from './resources';
import { STORAGE_DIRECTORY } from './config';
import { nodeCommand } from './node_command';
import { remoteLoginCommand, ssh } from './pi_launch';
import { output, runLimited, shellQuote } from './process_io';
import * as Registry from './session_registry';
import type { RemoteHost } from './settings_types';

export async function recoverRemote(host: RemoteHost): Promise<void> {
  const command = `PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} node -e ${shellQuote(storageTransactionBundle)} ${shellQuote('{"action":"recover"}')}`;
  const result = await runLimited(ssh(host, remoteLoginCommand(command)), 256 * 1024, 'Could not recover session transactions');
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  if (result.stderr.length) console.error(result.stderr.toString().trim());
}

function recoveryPending(root: string): boolean {
  const database = Registry.open(root);
  try {
    const row = database.prepare("SELECT (EXISTS(SELECT 1 FROM session_publications) OR EXISTS(SELECT 1 FROM session_restorations) OR EXISTS(SELECT 1 FROM session_restore_receipts) OR EXISTS(SELECT 1 FROM deletion_records) OR EXISTS(SELECT 1 FROM storage_transactions) OR EXISTS(SELECT 1 FROM archive_records WHERE record_json IS NULL OR (COALESCE(json_extract(record_json, '$.finished'), 0) != 1 AND COALESCE(json_extract(record_json, '$.state'), '') != 'planned'))) AS pending").get() as { pending: number };
    return Boolean(row.pending);
  } finally { database.close(); }
}

export async function recover(root: string): Promise<void> {
  if (!recoveryPending(root)) return;
  const result = await output(nodeCommand(['-e', storageTransactionBundle, '{"action":"recover"}'], { env: { PIOP_RESTORE_ROOT: root } }));
  if (!result.status.success) throw new Error(`Session transaction recovery is pending: ${result.stderr.toString().trim()}`);
  if (result.stderr.length) console.error(result.stderr.toString().trim());
}
