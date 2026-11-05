import fs from 'node:fs';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import * as io from './session-publication-io.ts';
import * as assets from './goal-assets.ts';
import * as GoalDependencies from './goal-dependencies.ts';

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const workspaceSchema = Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal('existing'), Type.Literal('created-directory')]) });

const optionsSchema = Type.Object({ workspace: Type.Optional(workspaceSchema) });

const contractSchema = Type.Object({ version: Type.Literal(1), workspace: Type.Object({ ...workspaceSchema.properties, identity: identitySchema }), goalAssets: GoalDependencies.contractSchema });

function workspace(header, options) {
  const given = options.workspace ?? { path: header.cwd, kind: 'existing' };

  if (given.path !== header.cwd || !path.isAbsolute(given.path)) throw new Error('Publication workspace does not bind the session header');
  const canonical = fs.realpathSync(given.path);

  if (!fs.lstatSync(canonical).isDirectory()) throw new Error('Publication workspace is not a directory');

  return { ...given, path: canonical, identity: io.identity(canonical) };
}

function plan(root, entries, options = {}) {
  if (!Check(optionsSchema, options)) throw new Error('Invalid publication dependency options');
  const header = entries[0];

  const directories = assets.locked(root, () => {
    const references = assets.references(entries, root);
    assets.ownedDirectories(root, header.id).forEach(directory => references.add(directory));

    return [...references].map(directory => ({ path: directory, identity: assets.identity(directory) }));
  });

  const contract = { version: 1, workspace: workspace(header, options), goalAssets: { version: 1, policy: 'shared-profile', directories } };
  validate(root, header.id, contract);

  return contract;
}

function validate(root, _sessionId, contract): asserts contract is Static<typeof contractSchema> {
  if (!Check(contractSchema, contract) || !path.isAbsolute(contract.workspace.path)) throw new Error('Publication dependency ownership is invalid; retained');

  for (const directory of contract.goalAssets.directories) {
    if (!assets.validPath(root, directory.path)) throw new Error('Publication goal dependency is outside managed storage; retained');
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
}

export { contractSchema, plan, validate, retain };
