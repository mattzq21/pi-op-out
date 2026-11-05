import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as SessionDatabase from './session-database.ts';

const absolute = value => Check(Type.String(), value) && path.isAbsolute(value);

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String() });

const recoverySchema = Type.Object({ version: Type.Literal(1), managedBy: Type.Literal('piop'), kind: Type.Literal('missing-directory-recovery'), id: Type.String({ pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' }), state: Type.Union(['allocated', 'ready', 'published'].map(value => Type.Literal(value))), mode: Type.Literal('empty'), directory: Type.String(), originalCwd: Type.String(), owners: Type.Array(ownerSchema, { minItems: 1 }) });

const nullableString = Type.Union([Type.String(), Type.Null()]);

const registrySchema = Type.Object({ session_id: Type.String({ minLength: 1 }), session_path: nullableString, cwd: Type.String() });

interface RootOwner { sessionId: string; sessionPath?: string; kind: string }

interface StorageRoot {
  path: string;
  provenance: string[];
  ownership: string;
  owners: RootOwner[];
  state?: string;
  workdir?: string;
  originalCwd?: string;
  identity?: string;
  expectedIdentity?: string;
  category?: string;
  available?: boolean;
  directory?: boolean;
  claims?: { owners: { sessionId: string }[]; retiredOwners?: string[] };
  contracts?: { owner: RootOwner; identities: Set<string> }[];
}

interface Discovery {
  cwds: Map<string, StorageRoot>;
  recovery: Map<string, StorageRoot>;
  retainedArtifacts: Map<string, StorageRoot>;
  sessionPaths: Set<string>;
  warnings: string[];
  sessions?: Map<string, RootOwner[]>;
  headers?: Map<string, { id: string; cwd?: string }>;
  goals?: Map<string, StorageRoot>;
}

function addRoot(roots: Map<string, StorageRoot>, target, provenance: string, ownership = 'referenced', owners: RootOwner[] = []): StorageRoot | undefined {
  if (!absolute(target)) return;
  const normalized = path.normalize(target);

  let root = roots.get(normalized);

  if (!root) { root = { path: normalized, provenance: [], ownership, owners: [] }; roots.set(normalized, root); }

  if (!root.provenance.includes(provenance)) root.provenance.push(provenance);

  for (const owner of owners) {
    if (!root.owners.some(saved => saved.sessionId === owner.sessionId && saved.sessionPath === owner.sessionPath && saved.kind === owner.kind)) root.owners.push(owner);
  }

  return root;
}


async function readRegistry(profile, discovery) {
  const database = path.join(profile, 'sessions.sqlite');

  try {
    await fs.lstat(database);
    const tables = SessionDatabase;
    const db = tables.connection(profile);
    const rows = db.prepare(tables.directoryQuery(db, ['session_id', 'session_path', 'cwd'])).all();

    for (const row of rows) {
      if (!Check(registrySchema, row)) { discovery.warnings.push(`${database}: invalid registry row; owner provenance is unresolved`); continue; }

      const owners = [{ sessionId: row.session_id, sessionPath: row.session_path || undefined, kind: 'registry-only' }];
      addRoot(discovery.cwds, row.cwd, `Session registry: ${row.session_id}`, 'referenced', owners);

      if (absolute(row.session_path)) discovery.sessionPaths.add(row.session_path);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${database}: registry provenance unavailable: ${error.message}`);
  }
}

function validRecovery(record, container) {
  return Check(recoverySchema, record) && path.basename(container) === record.id
    && record.directory === path.join(container, 'workdir') && absolute(record.originalCwd)
    && record.owners.every(owner => absolute(owner.sessionPath));
}

async function recoveryRoots(profile, discovery) {
  const root = path.join(profile, 'recovery');

  try {
    for (const row of SessionDatabase.recoveryRecords(profile) as { record_id: string; record_json: string }[]) {
      await readRecoveryContainer(path.join(root, row.record_id), row.record_json, discovery);
    }
  } catch (error) { discovery.warnings.push(`${root}: recovery ownership unavailable: ${error.message}`); }
}

async function readRecoveryContainer(container, body, discovery) {
  const recordRoot = addRoot(discovery.recovery, container, 'Recovery container without verified ownership', 'unattributed')!;
  recordRoot.state = 'unmarked';

  try {
    const record = JSON.parse(body);

    if (!validRecovery(record, container)) throw new Error('Invalid recovery ownership record');

    if (!(await fs.lstat(container)).isDirectory()) throw new Error('Recovery container is not a regular directory');
    recordRoot.ownership = 'owned';
    recordRoot.state = record.state;
    recordRoot.provenance = [`Recovery ownership v1: ${record.mode}; original directory: ${record.originalCwd}`];
    recordRoot.owners = record.owners.map(owner => ({ ...owner, kind: 'unresolved' }));
    recordRoot.workdir = record.directory;
    recordRoot.originalCwd = record.originalCwd;
    addRoot(discovery.cwds, record.directory, `Recovery ${record.id}: ${record.state}`, 'owned', recordRoot.owners);

    for (const owner of record.owners) discovery.sessionPaths.add(owner.sessionPath);
    recordRecoverySource(record, discovery, recordRoot.owners);

    if (record.state !== 'published') discovery.warnings.push(`${container}: retained ${record.state} recovery; publication is incomplete and reclaimable space is unknown`);
  } catch (error) { discovery.warnings.push(`${container}: recovery ownership unresolved: ${error.message}`); }
}

function recordRecoverySource(record, discovery, owners) {
  const source = record.recovered?.sourceCwd;

  if (!absolute(source)) return;
  const provenance = `Retained recovery migration source: ${record.id}`;
  addRoot(discovery.cwds, source, provenance, 'referenced', owners);

}

async function discoverRoots(profile): Promise<Discovery> {
  const discovery: Discovery = { cwds: new Map(), recovery: new Map(), retainedArtifacts: new Map(), sessionPaths: new Set(), warnings: [] };
  await readRegistry(profile, discovery);
  await recoveryRoots(profile, discovery);

  return discovery;
}

export type { RootOwner, StorageRoot, Discovery };
export { absolute, addRoot, discoverRoots };
