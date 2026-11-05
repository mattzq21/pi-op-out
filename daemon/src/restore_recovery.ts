import * as storageTransactions from './storage_transactions';
import { pending } from '../resources/session-database.cjs';

export async function recover(root: string): Promise<void> {
  if (!pending(root, 'recovery')) return;
  await storageTransactions.recover({ root, busyIsOk: true });
}
