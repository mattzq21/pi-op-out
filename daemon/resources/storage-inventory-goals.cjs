const fs = require('node:fs/promises');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { absolute, addRoot } = require('./storage-inventory-roots.cjs');

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const directorySchema = Type.Object({ path: Type.String(), identity: identitySchema });

const contractSchema = Type.Object({ version: Type.Literal(1), policy: Type.Literal('shared-profile'), directories: Type.Array(directorySchema) });

const claimsSchema = Type.Object({ version: Type.Literal(1), kind: Type.Literal('goal-assets'), owners: Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Optional(Type.String()) })), retiredOwners: Type.Optional(Type.Array(Type.String())) });

function validGoalPath(directory) { return absolute(directory) && /^goal-[a-zA-Z0-9_-]+$/.test(path.basename(directory)) && path.basename(path.dirname(directory)) === 'attachments'; }

function observeGoalContract(observation, entry) {
  if (entry.goalAssets === undefined) return;

  if (!Check(contractSchema, entry.goalAssets)) {
    observation.goalWarnings.push('Invalid goalAssets dependency contract; ownership unresolved');

    return;
  }

  for (const dependency of entry.goalAssets.directories) {
    if (!validGoalPath(dependency.path)) { observation.goalWarnings.push('Invalid goalAssets directory: ' + dependency.path); continue; }

    observation.goals.add(dependency.path);

    if (!observation.goalContracts.has(dependency.path)) observation.goalContracts.set(dependency.path, new Set());
    observation.goalContracts.get(dependency.path).add(dependency.identity);
  }
}

function goalOwner(record) { return Boolean(record?.owners.some(owner => ['fork-history', 'fork-dependency-history'].includes(owner.kind) || /^(active|archived|referenced)-goal-(history|contract|dependency)$/.test(owner.kind))); }

async function directoryIdentity(directory) {
  const metadata = await fs.lstat(directory, { bigint: true });

  if (!metadata.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Goal asset directory is unavailable or has ambiguous ancestry');

  return metadata.dev + ':' + metadata.ino;
}

function contractMatches(profile, record, proof, identity) {
  return managedGoal(profile, record.path) && proof.identities.size === 1 && proof.identities.has(identity) && (proof.owner.kind.startsWith('diagnostic-') || claimed(record, proof.owner));
}

function sameReference(owner, expected) {
  return owner.sessionId === expected.sessionId && owner.sessionPath === expected.sessionPath && owner.kind.startsWith('diagnostic-') === expected.kind.startsWith('diagnostic-');
}

async function reconcileContract(profile, record, discovery) {
  if (!record.contracts?.length) return;
  let identity;

  try { identity = await directoryIdentity(record.path); }
  catch (error) { discovery.warnings.push(record.path + ': goalAssets ownership proof unavailable: ' + error.message); }

  for (const proof of record.contracts) {
    if (contractMatches(profile, record, proof, identity)) continue;
    record.owners = record.owners.map(owner => sameReference(owner, proof.owner) ? { ...owner, kind: owner.kind.startsWith('diagnostic-') ? owner.kind + '-unresolved' : 'unresolved' } : owner);
    discovery.warnings.push(record.path + ': goalAssets directory identity, managed location or durable owner claim differs from its contract in ' + proof.owner.sessionPath + '; retained');
  }
}

async function recordClaims(profile, record, discovery) {
  record.identity = undefined;
  record.claims = undefined;

  try {
    record.identity = await directoryIdentity(record.path);
    const file = path.join(profile, 'sessions.sqlite');
    const claims = require('./piop-storage/goal-ownership.cjs').read(profile, record.path);

    if (claims === undefined) return;

    if (!Check(claimsSchema, claims)) throw new Error('Invalid goal asset ownership claims');
    record.claims = claims;

    for (const owner of claims.owners) addRoot(discovery.goals, record.path, 'Durable claim in ' + file + '; claims are provenance, not live owners', record.ownership, [{ ...owner, kind: 'goal-claim-provenance' }]);

    for (const sessionId of claims.retiredOwners ?? []) addRoot(discovery.goals, record.path, 'Retired claim in ' + file + '; historical provenance only', record.ownership, [{ sessionId, kind: 'retired-goal-claim-provenance' }]);
  } catch (error) {
    if (error.code !== 'ENOENT') discovery.warnings.push(record.path + ': goal claim discovery unavailable: ' + error.message + '; retained');
  }
}

function managedGoal(profile, directory) { return validGoalPath(directory) && path.resolve(directory) === directory && directory.startsWith(profile + path.sep) && !/-pending-[a-zA-Z0-9]+$/.test(directory); }

function claimed(record, owner) { return Boolean(record.claims?.owners.some(claim => claim.sessionId === owner.sessionId)); }

function dependencyKind(owner) {
  return ['fork-history', 'fork-dependency-history'].includes(owner.kind) ? 'fork-dependency-history' : owner.kind.replace(/-goal-(history|contract|dependency)$/, '-goal-dependency');
}

function propagateDependency(record, target, owner, verified, source, discovery) {
  const diagnostic = owner.kind.startsWith('diagnostic-');
  const proven = verified && claimed(record, owner) && claimed(target, owner);
  const kind = diagnostic ? owner.kind : proven ? dependencyKind(owner) : 'unresolved-goal-dependency';
  const proof = diagnostic ? 'Diagnostic dependency reference; not a live owner' : proven ? 'Verified directory identity and durable source/target claims' : 'Directory identity or durable ownership claim unresolved';
  const reference = { ...owner, kind };
  addRoot(discovery.goals, target.path, proof + '; dependency from ' + record.path + '; provenance, not runtime liveness', 'unattributed', [reference]);

  if (!diagnostic && !proven) discovery.warnings.push(source + ': dependency ownership for ' + owner.sessionId + ' is unresolved at ' + target.path + '; directory or durable claim proof unavailable; retained');

  return reference;
}

async function dependencyRecord(profile, record, dependency, owners, discovery) {
  if (!managedGoal(profile, dependency.path)) throw new Error('Goal dependency is outside managed profile storage: ' + dependency.path);
  const source = record.path + ' (saved goal dependencies)';
  const target = addRoot(discovery.goals, dependency.path, 'Durable transitive goal dependency in ' + source + '; expected directory identity: ' + dependency.identity, 'unattributed');

  await recordClaims(profile, target, discovery);
  const verified = dependency.identity === target.identity;

  for (const owner of owners) {
    const reference = propagateDependency(record, target, owner, verified, source, discovery);
    target.contracts ??= [];
    target.contracts.push({ owner: reference, identities: new Set([dependency.identity]) });
  }

  if (!verified) discovery.warnings.push(target.path + ': goal dependency directory differs from its durable identity in ' + source + '; retained and coverage incomplete');
}

async function dependencies(profile, record, discovery) {
  if (!managedGoal(profile, record.path)) return;
  const source = record.path + ' (saved goal dependencies)';

  try {
    if (!record.identity || await directoryIdentity(record.path) !== record.identity) throw new Error('Dependency source directory identity unavailable or changed');
    const contract = require('./piop-storage/goal-dependencies.cjs').read(profile, record.path);

    if (contract === undefined) {
      record.provenance.push('No saved dependency record; undeclared legacy text dependencies are outside verified ownership coverage');

      return;
    }

    if (!Check(contractSchema, contract)) throw new Error('Invalid durable goal dependency contract');
    const owners = record.owners.filter(owner => goalOwner({ owners: [owner] }) || owner.kind.startsWith('diagnostic-'));

    for (const dependency of contract.directories) await dependencyRecord(profile, record, dependency, owners, discovery);
  } catch (error) {
    if (error.code === 'ENOENT') {
      record.provenance.push('No saved dependency record; undeclared legacy text dependencies are outside verified ownership coverage');

      return;
    }

    discovery.warnings.push(source + ': transitive goal dependency coverage unavailable: ' + error.message + '; assets retained');
  }
}

async function reconcileGoalAssets(profile, discovery) {
  for (const record of discovery.goals.values()) {
    await recordClaims(profile, record, discovery);
    await reconcileContract(profile, record, discovery);
  }

  for (const record of discovery.goals.values()) await dependencies(profile, record, discovery);

  for (const record of discovery.goals.values()) {
    await recordClaims(profile, record, discovery);
    await reconcileContract(profile, record, discovery);
    record.ownership = goalOwner(record) ? 'shared' : 'unattributed';

    if (!goalOwner(record) && record.owners.some(owner => owner.kind.startsWith('diagnostic-'))) record.state = 'diagnostic-references-only';
  }
}

module.exports = { validGoalPath, observeGoalContract, goalOwner, reconcileGoalAssets };
