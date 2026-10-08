const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const absolute = value => Check(Type.String(), value) && path.isAbsolute(value);

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String() });

const recoverySchema = Type.Object({ version: Type.Literal(1), managedBy: Type.Literal('piop'), kind: Type.Literal('missing-directory-recovery'), id: Type.String({ pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' }), state: Type.Union(['allocated', 'ready', 'published'].map(value => Type.Literal(value))), mode: Type.Union(['empty', 'remote-branch', 'legacy-copy'].map(value => Type.Literal(value))), directory: Type.String(), originalCwd: Type.String(), owners: Type.Array(ownerSchema, { minItems: 1 }) });

const packageSchema = Type.Object({ name: Type.String(), piConfig: Type.Optional(Type.Object({ name: Type.Optional(Type.String()), configDir: Type.Optional(Type.String()) })) });

const nullableString = Type.Union([Type.String(), Type.Null()]);

const registrySchema = Type.Object({ session_id: Type.String({ minLength: 1 }), session_path: nullableString, cwd: Type.String(), repository_root: nullableString });

function addRoot(roots, target, provenance, ownership = 'referenced', owners = []) {
  if (!absolute(target)) return;
  const normalized = path.normalize(target);

  if (!roots.has(normalized)) roots.set(normalized, { path: normalized, provenance: [], ownership, owners: [] });
  const root = roots.get(normalized);

  if (!root.provenance.includes(provenance)) root.provenance.push(provenance);

  for (const owner of owners) {
    if (!root.owners.some(saved => saved.sessionId === owner.sessionId && saved.sessionPath === owner.sessionPath && saved.kind === owner.kind)) root.owners.push(owner);
  }

  return root;
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function readRegistry(profile, discovery) {
  const database = path.join(profile, 'sessions.sqlite');
  let db;

  try {
    await fs.lstat(database);
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(database, { readOnly: true });
    const rows = db.prepare(require('./session-database.cjs').repositoryQuery(db, ['session_id', 'session_path', 'cwd', 'repository_root'])).all();

    for (const row of rows) {
      if (!Check(registrySchema, row)) { discovery.warnings.push(`${database}: invalid registry row; owner provenance is unresolved`); continue; }

      const owners = [{ sessionId: row.session_id, sessionPath: row.session_path || undefined, kind: 'registry-only' }];
      addRoot(discovery.repositories, row.repository_root, `Session registry: ${row.session_id}`, 'referenced', owners);
      addRoot(discovery.cwds, row.cwd, `Session registry: ${row.session_id}`, 'referenced', owners);

      if (absolute(row.session_path)) discovery.sessionPaths.add(row.session_path);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${database}: registry provenance unavailable: ${error.message}`);
  } finally { db?.close(); }
}

function validRecovery(record, container) {
  return Check(recoverySchema, record) && path.basename(container) === record.id
    && record.directory === path.join(container, 'workdir') && absolute(record.originalCwd)
    && record.owners.every(owner => absolute(owner.sessionPath));
}

async function recoveryRoots(profile, discovery) {
  const root = path.join(profile, 'recovery');
  let entries;

  try {
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('Recovery root is not a regular directory');
    entries = await fs.readdir(root, { withFileTypes: true });
  }
  catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(`${root}: recovery ownership unavailable: ${error.message}`);

    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await readRecoveryContainer(path.join(root, entry.name), discovery);
  }
}

async function readRecoveryContainer(container, discovery) {
  const recordRoot = addRoot(discovery.recovery, container, 'Recovery container without verified ownership', 'unattributed');
  recordRoot.state = 'unmarked';

  try {
    const file = path.join(container, 'ownership.json');

    if (!(await fs.lstat(file)).isFile()) throw new Error('Ownership record is not a regular file');
    const record = await readJson(file);

    if (!validRecovery(record, container)) throw new Error('Invalid recovery ownership record');
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

  if (legacyRecovery(source)) addRoot(discovery.legacy, path.basename(source) === 'workdir' ? path.dirname(source) : source, provenance, 'unattributed', owners);
}

function legacyRecovery(cwd) {
  return /^\/tmp\/piop-session-[a-zA-Z0-9]{6}$/.test(cwd)
    || /^\/tmp\/piop-recovery-[a-zA-Z0-9]{6}\/workdir$/.test(cwd);
}

async function temporaryRoots(discovery) {
  for (const root of new Set([os.tmpdir(), '/tmp'])) {
    let entries;

    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { discovery.warnings.push(`${root}: temporary storage discovery unavailable: ${error.message}`); continue; }

    for (const entry of entries) {
      const target = path.join(root, entry.name);

      if (entry.isDirectory() && /^piop-(?:session|recovery)-[a-zA-Z0-9]{6}$/.test(entry.name)) {
        addRoot(discovery.legacy, target, 'Legacy recovery name; no verified profile ownership', 'unattributed');
      }

      if (/^pi-desktop-btw-[a-f0-9-]{36}(?:\.jsonl(?:\.loop-detection\.json)?|\.diffs(?:\.json)?|\.snapshots)$/.test(entry.name)) {
        addRoot(discovery.ephemeral, target, 'Piop side conversation artifact; runtime liveness unknown', 'unattributed');

        if (entry.isFile() && entry.name.endsWith('.jsonl')) discovery.sessionPaths.add(target);
      }
    }
  }
}

function piCandidates(selected) {
  if (selected) {
    const expanded = selected.startsWith('~/') ? path.join(os.homedir(), selected.slice(2)) : selected;

    if (/[/\\]/.test(expanded)) return [path.resolve(expanded)];

    return (process.env.PATH || '').split(path.delimiter).map(directory => path.resolve(directory, expanded));
  }

  const candidates = ['.local/bin/pi', '.npm-global/bin/pi', '.bun/bin/pi'].map(file => path.join(os.homedir(), file));

  for (const directory of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.resolve(directory, 'pi'));

  return candidates;
}

async function selectedPiPath(profile, warnings) {
  const hint = process.env.PIOP_INVENTORY_PI_PATH || process.argv[1];

  if (hint) return hint;

  try {
    const settings = await readJson(path.join(profile, 'settings.json'));

    if (Check(Type.String({ minLength: 1 }), settings.piPath)) return settings.piPath;
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push(`Selected Pi settings unavailable: ${error.message}`);
  }

  warnings.push('ChatGPT coverage is limited to the host-discovered Pi auth directory and environment override. The caller did not identify the selected Pi executable; alternative installations or custom host Pi paths may use additional roots.');
}

async function piPackage(selected) {
  const candidates = piCandidates(selected);

  for (const candidate of candidates) {
    let directory;

    try { directory = path.dirname(await fs.realpath(candidate)); } catch { continue; }

    while (directory !== path.dirname(directory)) {
      try {
        const metadata = await readJson(path.join(directory, 'package.json'));

        if (Check(packageSchema, metadata) && ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata.name)) return metadata;
      } catch { }

      directory = path.dirname(directory);
    }
  }
}

function authDirectory(metadata) {
  const name = metadata?.piConfig?.name || 'pi';
  const configured = process.env[`${name.toUpperCase()}_CODING_AGENT_DIR`];

  const directory = configured ? path.resolve(configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured)
    : path.join(os.homedir(), metadata?.piConfig?.configDir || '.pi', 'agent');

  return { directory, configured };
}

async function chatGptRoots(profile, discovery) {
  const selected = await selectedPiPath(profile, discovery.warnings);
  const metadata = await piPackage(selected);
  const { directory, configured } = authDirectory(metadata);
  const root = path.join(directory, 'piop-chatgpt');

  const provenance = configured ? 'Pi auth-directory environment override' : 'Pi auth-directory configuration; all stored accounts';
  addRoot(discovery.chatgpt, root, selected ? `${provenance}; selected Pi: ${selected}` : `${provenance}; host-discovered Pi`, 'shared');

  if (!metadata) discovery.warnings.push('Pi installation configuration unavailable; ChatGPT discovery covers the default/overridden auth directory only.');

  try {
    await fs.stat(directory);
    await fs.lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === root) {
      discovery.chatgpt.delete(root);

      return;
    }

    discovery.warnings.push(`${root}: auth-directory ChatGPT storage unavailable: ${error.message}`);
  }
}

async function discoverRoots(profile) {
  const discovery = { repositories: new Map(), cwds: new Map(), recovery: new Map(), legacy: new Map(), ephemeral: new Map(), ephemeralRecords: new Map(), cleanup: new Map(), pendingSnapshots: new Map(), transfers: new Map(), retainedArtifacts: new Map(), chatgpt: new Map(), sessionPaths: new Set(), warnings: [] };
  await readRegistry(profile, discovery);
  await recoveryRoots(profile, discovery);
  await temporaryRoots(discovery);
  await chatGptRoots(profile, discovery);

  return discovery;
}

module.exports = { absolute, addRoot, discoverRoots, legacyRecovery };
