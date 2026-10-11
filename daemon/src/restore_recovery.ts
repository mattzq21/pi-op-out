import * as storageTransactions from './storage_transactions';
import * as Registry from './session_registry';
import type { RemoteHost } from './settings_types';

export async function recoverRemote(host: RemoteHost): Promise<void> {
  await storageTransactions.recover({ kind: 'remote', host }, { busyIsOk: true });
}

export async function recover(root: string): Promise<void> {
  if (!Registry.pending(root, 'recovery')) return;
  await storageTransactions.recover({ kind: 'local' }, { root, busyIsOk: true });
}
