import { readFileSync } from 'node:fs';
import { isAuxiliary, records } from '../resources/piop-storage/session-records.cjs';
import { locateSessionFile, sessionDescendants } from './archives';
import * as storageTransactions from './storage_transactions';
import { StorageTransactionError, type RestoreResult } from './storage_transactions';
import type { FolderMove } from './storage_transactions';

/** The hold of the Host daemon on one session during a restore. */
export interface RestoreLease {
  finishRestore(restoredPath: string): Promise<void>;
  /** Ends the hold if finishRestore did not. */
  release(): Promise<void>;
}

/**
 * Restores the archived session tree at sessionPath on this machine. Sessions whose folder matches a cwdMoves entry get
 * the new folder in the same transaction.
 * When the run fails but a restore receipt shows that this tree is already restored, returns the saved result.
 * Throws the first error when there is no receipt, or a pending StorageTransactionError when an earlier restore must finish first.
 */
export async function restoreSessionTree(sessionPath: string, lease: (path: string) => Promise<RestoreLease>, cwdMoves: FolderMove[] = []): Promise<RestoreResult> {
  const leases: Array<[string, RestoreLease]> = [];
  let source = sessionPath;
  try {
    let result: RestoreResult, restored: string[];
    try {
      source = await locateSessionFile(sessionPath, true);
      assertRootRestore(source);
      leases.push([source, await lease(source)]);
      for (const [child] of await sessionDescendants(source, true, false)) leases.push([child, await lease(child)]);
      result = await storageTransactions.restore(leases.map(([path]) => path), cwdMoves);
      restored = restoredPaths(result, leases.map(([path]) => path));
    } catch (error) {
      result = await savedResult(source, error);
      restored = restoredPaths(result, leases.map(([path]) => path));
    }
    for (const [index, [, held]] of leases.entries()) {
      try { await held.finishRestore(restored[index]); }
      catch (error: any) { console.error(`Restore committed; could not acknowledge ownership release: ${error?.message ?? error}`); }
    }
    return result;
  } finally {
    for (const [path, held] of leases) {
      try { await held.release(); }
      catch (error: any) { console.error(`Could not release the restore hold on ${path}: ${error?.message ?? error}`); }
    }
  }
}

async function savedResult(source: string, failure: unknown): Promise<RestoreResult> {
  let saved: RestoreResult | null;
  try { saved = await storageTransactions.committedRestore(source); }
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

export function assertRootRestore(source: string): void {
  const entries = readFileSync(source, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const saved = records(source, entries[0]?.id).map((record: any) => record.entry);
  if (isAuxiliary([...entries, ...saved])) throw new Error('Auxiliary sessions can only be restored with their root session');
}
