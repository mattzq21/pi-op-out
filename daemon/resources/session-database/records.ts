import { databaseExists, transaction } from './core.ts';
import { applicationSetting, createApplicationSetting, removeApplicationSetting, saveApplicationSetting } from './settings.ts';
import { onMainThread } from './main-thread.ts';

export type RecordName = 'settings' | 'agent-definitions' | 'daemon' | 'daemon-id' | 'debug-mobile' | 'debug-mobile-identity' | 'plugins';


// The daemon's named records in the storage database of a storage root. Only the daemon changes them; Pi and the
// clients read them.
//   settings: the app settings.
//   agent-definitions: the global agent definitions.
//   daemon: how clients connect to the running daemon.
//   daemon-id: the identity of the daemons of this storage root.
//   debug-mobile, debug-mobile-identity: the debug connection for the mobile app.
//   plugins: the plugins that are on, and those the daemon has offered.
const NAMES = new Set(['settings', 'agent-definitions', 'daemon', 'daemon-id', 'debug-mobile', 'debug-mobile-identity', 'plugins']);

function checked(name: string): string {
  if (!NAMES.has(name)) throw new Error('Unknown application record: ' + name);
  return name;
}

function get(root: string, name: string): Buffer | undefined { return applicationSetting(root, checked(name)); }

// The record name of root, or undefined when it or the storage database does not exist.
function read(root: string, name: RecordName): Buffer | undefined {
  checked(name);
  if (!databaseExists(root)) return undefined;
  return get(root, name);
}

// The record name of root as JSON, or undefined when it does not exist.
function readJson(root: string, name: RecordName): any {
  const value = read(root, name);
  return value === undefined ? undefined : JSON.parse(value.toString('utf8'));
}

const save = onMainThread('application-records.save', (root: string, name: RecordName, value: Buffer | string): void => {
  saveApplicationSetting(root, checked(name), Buffer.from(value));
});

// Removes the record only if it still has the value expected. True when it was removed.
const removeIfEqual = onMainThread('application-records.removeIfEqual', (root: string, name: RecordName, expected: Buffer | string): boolean => {
  return transaction(root, 'IMMEDIATE', () => {
    const current = get(root, name);
    if (!current || !current.equals(Buffer.from(expected))) return false;
    removeApplicationSetting(root, name);
    return true;
  });
});

// The record, saved first with the value initial when it does not exist.
const created = onMainThread('application-records.readOrCreate', (root: string, name: RecordName, initial: Buffer | string): Buffer => {
  return transaction(root, 'IMMEDIATE', () => {
    const saved = get(root, name);
    if (saved) return saved;
    createApplicationSetting(root, name, Buffer.from(initial));
    return Buffer.from(initial);
  });
});

function readOrCreate(root: string, name: RecordName, initial: Buffer | string): Buffer { return Buffer.from(created(root, name, initial)); }

export { read, readJson, save, removeIfEqual, readOrCreate };
