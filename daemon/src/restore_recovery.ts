import * as storageTransactions from './storage_transactions';
import * as Registry from './session_registry';
import type { RemoteHost } from './settings_types';

export async function recoverRemote(host: RemoteHost): Promise<void> {
  await storageTransactions.recover({ kind: 'remote', host }, { busyIsOk: true });
}

function recoveryPending(root: string): boolean {
  const database = Registry.open(root);
  try {
    const row = database.prepare('SELECT (EXISTS(SELECT 1 FROM session_publications) OR EXISTS(SELECT 1 FROM session_restore_receipts) OR EXISTS(SELECT 1 FROM storage_transactions)) AS pending').get() as { pending: number };
    return Boolean(row.pending);
  } finally { database.close(); }
}

export async function recover(root: string): Promise<void> {
  if (!recoveryPending(root)) return;
  await storageTransactions.recover({ kind: 'local' }, { root, busyIsOk: true });
}
