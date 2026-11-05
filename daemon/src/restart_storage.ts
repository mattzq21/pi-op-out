import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import * as Storage from '../resources/session-database/index.ts';

// The records of a daemon restart in the storage database of root:
//   plan: the restart in progress: its identity, the daemon that asked for it, the new and the fallback daemon file,
//     the plugins to turn on and those that were on, and the addresses the new daemon listens on.
//   status: its phase, which clients read, with the error and the new daemon's process while they are known.
// And the backups of the running daemon that a restart can return to, each with the digest of its file.
const planSchema = Type.Object({
  id: Type.String(), owner: Type.Integer(), executable: Type.String(), fallback: Type.String(),
  enabled: Type.Array(Type.String()), previous: Type.Array(Type.String()), bind: Type.String(), debug_bind: Type.Union([Type.String(), Type.Null()]),
});

const statusSchema = Type.Object({
  restartId: Type.String(), phase: Type.Union([Type.Literal('preparing'), Type.Literal('armed'), Type.Literal('restarting'), Type.Literal('failed'), Type.Literal('complete'), Type.Literal('rolled_back')]),
  error: Type.Union([Type.String(), Type.Null()]), processId: Type.Union([Type.Integer(), Type.Null()]), expiresAt: Type.Integer(),
});

const SCHEMAS = { plan: planSchema, status: statusSchema };

export type RestartPlan = Static<typeof planSchema>;
export type RestartStatus = Static<typeof statusSchema>;
type Records = { plan: RestartPlan; status: RestartStatus };
export type RestartRecord = keyof Records;

function checked<Name extends RestartRecord>(name: Name, value: unknown): Records[Name] {
  if (!Check(SCHEMAS[name], value)) throw new Error('Invalid restart ' + name);
  return value as Records[Name];
}

export function read<Name extends RestartRecord>(root: string, name: Name): Records[Name] | null {
  const record = Storage.restartRecordJson(root, name);
  return record === undefined ? null : checked(name, JSON.parse(record));
}

export function write<Name extends RestartRecord>(root: string, name: Name, value: Records[Name]): void {
  Storage.saveRestartRecordJson(root, name, JSON.stringify(checked(name, value)));
}

export function remove(root: string, name: RestartRecord): void {
  Storage.removeRestartRecord(root, name);
}

// digest is null while the backup file is still being written.
export function saveBackup(root: string, id: string, digest: string | null): void {
  Storage.saveRestartBackup(root, id, digest);
}

export function readBackup(root: string, id: string): { digest: string | null } | null {
  return Storage.restartBackup(root, id) ?? null;
}

export function removeBackup(root: string, id: string): void {
  Storage.removeRestartBackup(root, id);
}

export function backups(root: string): string[] {
  return Storage.restartBackupIds(root);
}
