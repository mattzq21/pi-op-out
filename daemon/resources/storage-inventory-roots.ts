import fs from 'node:fs';
import path from 'node:path';
import * as database from './session-database.ts';

export interface RootOwner { sessionId: string; sessionPath?: string; kind: string }

export interface StorageRoot {
  path: string; ownership: string; owners: RootOwner[];
  provenance: string[]; available?: boolean; directory?: boolean;
}

// The missing-folder recoveries, by folder: recovery/<chat ID> belongs to that chat while it is saved.
function recoveryRoots(profile: string, warnings: string[]): Map<string, StorageRoot> {
  const roots = new Map<string, StorageRoot>();
  const directory = path.join(profile, 'recovery');
  let names: string[];

  try { names = fs.readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${directory}: recovery folders unavailable: ${(error as Error).message}`);
    return roots;
  }

  for (const name of names) {
    const saved = database.savedSessionRow(profile, name);

    if (saved) roots.set(path.join(directory, name), { path: path.join(directory, name), ownership: 'owned', provenance: ['Empty folder for a chat whose folder was missing'], owners: [{ sessionId: name, sessionPath: saved.sessionPath, kind: 'recovery-owner' }] });
  }

  return roots;
}

export { recoveryRoots };
