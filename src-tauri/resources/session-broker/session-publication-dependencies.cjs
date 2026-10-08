const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-publication-io.cjs');
const assets = require('./goal-assets.cjs');

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const commitSchema = Type.String({ pattern: '^[a-f0-9]{40,64}$' });

const checkpointSchema = Type.Object({ root: Type.String(), ref: Type.String({ pattern: '^refs/pi-session-snapshots/[a-zA-Z0-9/._-]+$' }), commit: commitSchema, sourceRef: Type.Optional(Type.String()) });

const workspaceSchema = Type.Object({ path: Type.String(), kind: Type.Union(['existing', 'created-directory', 'created-worktree'].map(value => Type.Literal(value))), branch: Type.Optional(Type.String()) });

const optionsSchema = Type.Object({ workspace: Type.Optional(workspaceSchema), checkpoints: Type.Optional(Type.Array(checkpointSchema)) });

const goalSchema = Type.Object({ version: Type.Literal(1), policy: Type.Literal('shared-profile'), directories: Type.Array(Type.Object({ path: Type.String(), identity: identitySchema })) });

const contractSchema = Type.Object({ version: Type.Literal(1), workspace: Type.Object({ ...workspaceSchema.properties, identity: identitySchema }), goalAssets: goalSchema, checkpoints: Type.Array(checkpointSchema) });

const promptSchema = Type.Object({ key: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }), owner: Type.String({ pattern: '^[a-zA-Z0-9._-]+$' }), commit: commitSchema, repositoryRoot: Type.Optional(Type.String()) });

const snapshotSchema = Type.Object({ repositoryRoot: Type.String(), ref: Type.String({ pattern: '^refs/pi-session-snapshots/[^\\r\\n]*$' }), commit: commitSchema });

function git(root, args, input) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input, timeout: 10000, maxBuffer: 1024 * 1024 });

  if (result.error) throw result.error;

  if (result.status !== 0) throw new Error(`Publication checkpoint retained in ${root}: ${result.stderr.trim()}`);

  return result.stdout.trim();
}

function refValue(root, ref) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', ref], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });

  if (result.error) throw result.error;

  if (result.status === 128) return undefined;

  if (result.status !== 0) throw new Error(`Could not verify publication checkpoint: ${result.stderr.trim()}`);

  return result.stdout.trim();
}

function workspace(header, options) {
  const given = options.workspace ?? { path: header.cwd, kind: 'existing' };

  if (given.path !== header.cwd || !path.isAbsolute(given.path)) throw new Error('Publication workspace does not bind the session header');
  const canonical = fs.realpathSync(given.path);

  if (!fs.lstatSync(canonical).isDirectory()) throw new Error('Publication workspace is not a directory');

  return { ...given, path: canonical, identity: io.identity(canonical) };
}

function promptSource(entry, header) {
  const data = entry.data;

  if (entry.customType !== 'pi-project-prompt-checkpoint' || !Check(promptSchema, data)) return [];
  const ref = `refs/pi-session-snapshots/chats/${data.owner}/prompts/${data.key}`;

  for (const root of new Set([data.repositoryRoot, header.cwd].filter(Boolean))) {
    try { git(root, ['cat-file', '-e', `${data.commit}^{commit}`]);

    return [{ root, ref, commit: data.commit }]; }
    catch (_error) { continue; }
  }

  throw new Error(`Publication checkpoint ${data.commit} is unavailable in its recorded repositories`);
}

function sourcePointers(entries, header) {
  return entries.flatMap(entry => {
    if (entry.type !== 'custom') return [];

    if (entry.customType === 'pi-project-files-watch-snapshot' && Check(snapshotSchema, entry.data)) return [{ root: entry.data.repositoryRoot, ref: entry.data.ref, commit: entry.data.commit }];

    return promptSource(entry, header);
  });
}

function pinPointer(source, sessionId) {
  const root = fs.realpathSync(source.root);
  git(root, ['cat-file', '-e', `${source.commit}^{commit}`]);
  const key = io.hash(`${root}\n${source.ref}\n${source.commit}`);

  return { root, ref: `refs/pi-session-snapshots/chats/${sessionId}/publication/${key}`, commit: source.commit, sourceRef: source.ref };
}

function checkpoints(entries, header, options) {
  const records = new Map();

  for (const record of options.checkpoints ?? []) {
    const canonical = { ...record, root: fs.realpathSync(record.root) };
    records.set(`${canonical.root}\n${canonical.ref}`, canonical);
  }

  for (const source of sourcePointers(entries, header)) {
    const record = pinPointer(source, header.id);
    records.set(`${record.root}\n${record.ref}`, record);
  }

  return [...records.values()];
}

function plan(root, entries, options = {}) {
  if (!Check(optionsSchema, options)) throw new Error('Invalid publication dependency options');
  const header = entries[0];

  const directories = assets.locked(root, () => {
    const references = assets.references(entries, root);
    assets.ownedDirectories(root, header.id).forEach(directory => references.add(directory));

    return [...references].map(directory => ({ path: directory, identity: assets.identity(directory) }));
  });

  const contract = { version: 1, workspace: workspace(header, options), goalAssets: { version: 1, policy: 'shared-profile', directories }, checkpoints: checkpoints(entries, header, options) };
  validate(root, header.id, contract);

  return contract;
}

function validate(root, sessionId, contract) {
  if (!Check(contractSchema, contract) || !path.isAbsolute(contract.workspace.path)) throw new Error('Publication dependency ownership is invalid; retained');

  for (const directory of contract.goalAssets.directories) {
    if (!assets.validPath(root, directory.path)) throw new Error('Publication goal dependency is outside managed storage; retained');
  }

  for (const checkpoint of contract.checkpoints) {
    if (!path.isAbsolute(checkpoint.root) || !checkpoint.ref.startsWith(`refs/pi-session-snapshots/chats/${sessionId}/`)) throw new Error('Publication checkpoint lacks its child ownership namespace; retained');
  }
}

function pin(checkpoint) {
  if (refValue(checkpoint.root, checkpoint.ref) !== checkpoint.commit) {
    git(checkpoint.root, ['cat-file', '-e', `${checkpoint.commit}^{commit}`]);
    git(checkpoint.root, ['update-ref', '--stdin'], ['start', `create ${checkpoint.ref} ${checkpoint.commit}`, 'prepare', 'commit', ''].join('\n'));
  }

  syncRef(checkpoint);
}

function syncRef(checkpoint) {
  const common = fs.realpathSync(git(checkpoint.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));

  const loose = git(checkpoint.root, ['rev-parse', '--path-format=absolute', '--git-path', checkpoint.ref]);

  const file = io.exists(loose) ? loose : path.join(common, 'packed-refs');

  if (!io.inside(common, file)) throw new Error('Checkpoint ref storage has ambiguous ownership; retained');
  io.sync(file);

  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    io.sync(directory);

    if (directory === common) break;

    if (!io.inside(common, directory)) throw new Error('Checkpoint ref ancestry changed; retained');
  }
}

function retain(journal) {
  const contract = journal.dependencies;

  if (!contract) return;
  validate(journal.root, journal.sessionId, contract);

  if (!io.canonical(contract.workspace.path) || io.identity(contract.workspace.path) !== contract.workspace.identity) throw new Error('Publication workspace was replaced; dependencies retained');
  io.sync(contract.workspace.path);
  io.sync(path.dirname(contract.workspace.path));
  assets.verifyContract(journal.root, contract.goalAssets);
  assets.retainHistory(journal.root, [{ goalAssets: contract.goalAssets }], journal.sessionId, journal.target);
  contract.checkpoints.forEach(pin);
}

module.exports = { contractSchema, plan, validate, retain };
