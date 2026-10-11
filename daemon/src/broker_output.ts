import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir } from './private_fs';
import * as Registry from './session_registry';
import { FileLock, flockDescriptor, flockDescriptorSync } from './util/flock';
import type { Database } from './util/db';

function directory(): string { return join(homeDir(), STORAGE_DIRECTORY, 'broker-output'); }

function privateFile(path: string, create: boolean): number {
  const fd = openSync(path, constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW, 0o600);
  try { if (!fstatSync(fd).isFile()) throw new Error('Broker ownership must be a regular file'); }
  catch (error) { closeSync(fd); throw error; }
  return fd;
}

function creationGate(root: string): number {
  ensurePrivateDir(root);
  return privateFile(join(root, 'ownership.lock'), true);
}

function openRecords(root: string): Database {
  const database = Registry.open(dirname(root));
  database.exec('CREATE TABLE IF NOT EXISTS broker_output_directories (output_id TEXT PRIMARY KEY);');
  return database;
}

function reserve(root: string, id: string): void {
  const database = openRecords(root);
  try { database.prepare('INSERT INTO broker_output_directories VALUES (?)').run(id); } finally { database.close(); }
}

function paths(root: string): string[] {
  const database = openRecords(root);
  try {
    const rows = database.prepare('SELECT output_id FROM broker_output_directories ORDER BY output_id').all() as Array<{ output_id: string }>;
    return rows.map(row => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.output_id)) throw new Error('Invalid saved agent output directory');
      return join(root, row.output_id);
    });
  } finally { database.close(); }
}

function forgetMissing(path: string): void {
  try { lstatSync(path); return; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const root = dirname(path);
  const fd = openSync(root, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const database = openRecords(root);
  try { database.prepare('DELETE FROM broker_output_directories WHERE output_id=?').run(basename(path)); } finally { database.close(); }
}

/** Agent output files. The worker keeps shared locks on them so a later daemon does not delete live output. */
export class MessageOutput {
  private owner: number | undefined;
  private outputs: number[] = [];
  private removed = false;

  private constructor(public root: string, public stdout: string, public stderr: string) {}

  static async prepare(): Promise<MessageOutput> {
    const parent = directory();
    const gate = creationGate(parent);
    let output: MessageOutput | undefined;
    try {
      await flockDescriptor(gate, true, true);
      const id = randomUUID();
      reserve(parent, id);
      const root = join(parent, id);
      mkdirSync(root, { mode: 0o700 });
      output = new MessageOutput(root, join(root, 'stdout'), join(root, 'stderr'));
      const owner = privateFile(join(root, 'owner.lock'), true);
      output.owner = owner;
      await flockDescriptor(owner, true, true);
      writeSync(owner, `{"version":2,"processId":${process.pid}}\n`);
      fsyncSync(owner);
      for (const path of [output.stdout, output.stderr]) {
        const fd = privateFile(path, true);
        output.outputs.push(fd);
        await flockDescriptor(fd, true, true);
      }
      return output;
    } catch (error) { output?.remove(); throw error; }
    finally { closeSync(gate); }
  }

  /** Standard input, output, error, and the inherited owner lock for the worker. */
  stdio(): ['pipe', number, number, number] { return ['pipe', this.outputs[0]!, this.outputs[1]!, this.owner!]; }

  /** Closes the daemon copies of the output files after the worker starts. */
  closeOutputs(): void { for (const fd of this.outputs.splice(0)) { try { closeSync(fd); } catch {} } }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.closeOutputs();
    if (this.owner !== undefined) { try { closeSync(this.owner); } catch {} this.owner = undefined; }
    try { collectOwned(this.root); forgetMissing(this.root); }
    catch (error: any) { console.error(`Could not remove agent output ${this.root}: ${error.message ?? error}`); }
  }
}

function ownedDirectory(path: string): boolean {
  let stats;
  try { stats = lstatSync(path); } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!stats.isDirectory()) return false;
  if (typeof process.geteuid === 'function' && stats.uid !== process.geteuid()) return false;
  return true;
}

function outputFiles(path: string): string[] | undefined {
  if (!ownedDirectory(path)) return undefined;
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const recognized = entry.name === 'stdout' || entry.name === 'stderr' || entry.name === 'owner.lock';
    if (!recognized || !entry.isFile()) return undefined;
    files.push(join(path, entry.name));
  }
  return files;
}

function claimFile(path: string): FileLock | undefined {
  const fd = privateFile(path, false);
  try {
    if (flockDescriptorSync(fd, false, false)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}

function collectOwned(path: string): void {
  const files = outputFiles(path);
  if (!files) return;
  if (files.length === 0) { removeOutput(path, files); return; }
  const claims: FileLock[] = [];
  try {
    const owner = claimFile(join(path, 'owner.lock'));
    if (!owner) return;
    claims.push(owner);
    for (const file of files) {
      if (basename(file) === 'owner.lock') continue;
      const claim = claimFile(file);
      if (!claim) return;
      claims.push(claim);
    }
    removeOutput(path, files);
  } finally { for (const claim of claims) claim.release(); }
}

function removeOutput(path: string, files: string[]): void {
  files.sort((left, right) => Number(basename(left) === 'owner.lock') - Number(basename(right) === 'owner.lock'));
  for (const file of files) { try { unlinkSync(file); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } }
  try { rmdirSync(path); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

export async function recover(): Promise<void> {
  try {
    const root = directory();
    const gate = creationGate(root);
    try {
      await flockDescriptor(gate, true, false);
      for (const path of paths(root)) {
        try { collectOwned(path); forgetMissing(path); }
        catch (error: any) { console.error(`Broker output retained at ${path}: ${error.message ?? error}`); }
      }
    } finally { closeSync(gate); }
  } catch (error: any) { console.error(`Could not recover broker output: ${error.message ?? error}`); }
}
