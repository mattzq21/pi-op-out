import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as database from './session-database.ts';

export interface RootOwner { sessionId: string; sessionPath?: string; kind: string }

export interface StorageRoot {
  path: string; ownership: string; owners: RootOwner[]; state?: string; workdir?: string;
  provenance: string[]; available?: boolean; directory?: boolean;
}

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String() });

const recoverySchema = Type.Object({ id: Type.String(), state: Type.String(), mode: Type.String(), directory: Type.String(), originalCwd: Type.String(), owners: Type.Array(ownerSchema, { minItems: 1 }) });

// The missing-folder recoveries that the database keeps, by container folder.
function recoveryRoots(profile: string, warnings: string[]): Map<string, StorageRoot> {
  const roots = new Map<string, StorageRoot>();

  try {
    for (const row of database.recoveryRecords(profile)) {
      const container = path.join(profile, 'recovery', row.record_id);
      const record = JSON.parse(row.record_json);

      if (!Check(recoverySchema, record)) { warnings.push(`${container}: invalid recovery record`); continue; }
      roots.set(container, {
        path: container, ownership: 'owned', state: record.state, workdir: record.directory,
        provenance: [`Recovery ownership v1: ${record.mode}; original directory: ${record.originalCwd}`],
        owners: record.owners.map(owner => ({ ...owner, kind: 'recovery-owner' })),
      });

      if (record.state !== 'published') warnings.push(`${container}: retained ${record.state} recovery; publication is incomplete and reclaimable space is unknown`);
    }
  } catch (error) { warnings.push(`${path.join(profile, 'recovery')}: recovery records unavailable: ${(error as Error).message}`); }

  return roots;
}

export { recoveryRoots };
