import { locateSessionFile, sessionDescendants } from './archives';
import type { Host } from './host_connection';
import * as storageTransactions from './storage_transactions';
import { StorageTransactionError, type RestoreResult } from './storage_transactions';

/** The hold of the Host daemon on one session during a restore. */
export interface RestoreLease {
  finishRestore(restoredPath: string): Promise<void>;
  /** Ends the hold if finishRestore did not. */
  release(): Promise<void>;
}

/**
 * Restores the archived session tree at sessionPath on the host.
 * When the run fails but a restore receipt shows that this tree is already restored, returns the saved result.
 * Throws the first error when there is no receipt, or a pending StorageTransactionError when an earlier restore must finish first.
 */
export async function restoreSessionTree(host: Host, sessionPath: string, lease: (path: string) => Promise<RestoreLease>): Promise<RestoreResult> {
  const leases: Array<[string, RestoreLease]> = [];
  let source = sessionPath;
  try {
    let result: RestoreResult;
    try {
      source = await locateSessionFile(host, sessionPath, true);
      leases.push([source, await lease(source)]);
      for (const [child] of await sessionDescendants(host, source, true, false)) leases.push([child, await lease(child)]);
      result = await storageTransactions.restore(host, leases.map(([path]) => path));
    } catch (error) {
      result = await savedResult(host, source, error);
    }
    const restored = restoredPaths(result, leases.map(([path]) => path));
    for (const [index, [, held]] of leases.entries()) {
      try { await held.finishRestore(restored[index]!); }
      catch (error: any) { console.error(`Restore committed; could not acknowledge ownership release: ${error?.message ?? error}`); }
    }
    return result;
  } finally {
    for (const [, held] of leases) await held.release();
  }
}

async function savedResult(host: Host, source: string, failure: unknown): Promise<RestoreResult> {
  let saved: RestoreResult | null;
  try { saved = await storageTransactions.committedRestore(host, source); }
  catch (error: any) {
    if (error instanceof StorageTransactionError && error.state === 'pending') throw error;
    console.error(`Could not read the restore receipt of ${source}: ${error?.message ?? error}`);
    throw failure;
  }
  if (!saved) throw failure;
  return saved;
}

function restoredPaths(result: RestoreResult, sources: string[]): string[] {
  return sources.map(source => {
    const session = result.sessions.find(session => session.sourcePath === source);
    if (!session) throw new Error('Storage transaction committed, but its result is invalid: no restored session for ' + source);
    return session.sessionPath;
  });
}
