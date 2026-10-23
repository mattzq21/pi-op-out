import * as storageTransactions from './storage_transactions';
import * as Registry from './session_registry';

export async function recover(root: string): Promise<void> {
  if (!Registry.pending(root, 'recovery')) return;
  await storageTransactions.recover({ root, busyIsOk: true });
}
