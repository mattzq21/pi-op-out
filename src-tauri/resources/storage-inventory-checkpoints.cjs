const { checkpointOwners, ownerCategory } = require('./storage-inventory-owners.cjs');

const ids = ['project-checkpoints', 'unattributed-project-checkpoints', 'archived-project-checkpoints'];

async function checkpointBytes(cwd, refs, snapshots, git) {
  if (!snapshots.length) return 0;
  const snapshotRefs = new Set(snapshots);
  const ordinary = refs.flatMap(ref => snapshotRefs.has(ref) ? [] : [`^${ref}`]);

  try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); ordinary.push('^HEAD'); } catch { }

  const revisions = `${snapshots.join('\n')}\n${ordinary.join('\n')}\n`;
  const objects = new Set((await git(cwd, ['rev-list', '--objects', '--stdin'], revisions)).trim().split('\n').flatMap(line => line ? [line.split(' ', 1)[0]] : []));

  if (!objects.size) return 0;
  const sizes = await git(cwd, ['cat-file', '--batch-check=%(objectsize:disk)'], `${[...objects].join('\n')}\n`);
  let byteSize = 0;

  for (const value of sizes.trim().split('\n')) {
    if (!/^\d+$/.test(value)) throw new Error('Git object size unavailable');
    byteSize += Number(value);
  }

  return byteSize;
}

async function collectRepositories(discovery, categories, warnings, checkpointRepository) {
  const repositories = new Map();

  for (const record of discovery.repositories.values()) {
    const repository = await checkpointRepository(record.path);

    if (repository.error) {
      if (repository.notGit && record.optionalRepository) continue;
      warnings.push(repository.error);
      categories.get('unattributed-project-checkpoints').roots.push({ ...record, available: false, ownership: 'unattributed' });
      continue;
    }

    if (!repositories.has(repository.common)) repositories.set(repository.common, []);
    repositories.get(repository.common).push(record);
  }

  return repositories;
}

function groupRefs(refs, records, sessions) {
  const groups = new Map(ids.map(id => [id, []]));
  const owners = new Map(ids.map(id => [id, new Map()]));

  for (const { ref, oid } of refs) {
    if (ref !== 'refs/pi-session-snapshots' && !ref.startsWith('refs/pi-session-snapshots/')) continue;
    const matches = checkpointOwners(ref, oid, records, sessions);
    const id = ownerCategory(matches);
    groups.get(id).push(ref);

    for (const owner of matches) owners.get(id).set(JSON.stringify(owner), owner);
  }

  return { groups, owners };
}

async function measureGroups(common, records, refs, grouped, categories, measuredDirectories, git) {
  let excluded = refs.map(({ ref }) => ref);

  for (const id of ids.toReversed()) {
    const snapshots = grouped.groups.get(id);

    if (!snapshots.length) continue;
    const category = categories.get(id);
    category.itemCount += snapshots.length;
    category.directories.push(common);
    const provenance = [...new Set(records.flatMap(record => record.provenance))];

    if (measuredDirectories.has(common)) provenance.push('Object files already counted by the allocated-block directory scan; no additional estimate');
    category.roots.push({ path: common, available: true, ownership: id === 'unattributed-project-checkpoints' ? 'unattributed' : 'shared', provenance, owners: [...grouped.owners.get(id).values()], refs: snapshots });

    if (!measuredDirectories.has(common)) category.byteSize += await checkpointBytes(common, excluded, snapshots, git);
    const removed = new Set(snapshots);
    excluded = excluded.filter(ref => !removed.has(ref));
  }
}

async function inspectRepository(common, records, discovery, categories, measuredDirectories, warnings, git) {
  try {
    const output = await git(common, ['for-each-ref', '--format=%(refname) %(objectname)']);

    const refs = output.trim().split('\n').flatMap(line => {
      if (!line) return [];
      const [ref, oid] = line.split(' ');

      return [{ ref, oid }];
    });

    const grouped = groupRefs(refs, records, discovery.sessions);
    await measureGroups(common, records, refs, grouped, categories, measuredDirectories, git);
  } catch (error) {
    warnings.push(`${common}: checkpoint inventory unavailable: ${error.message}`);
    categories.get('unattributed-project-checkpoints').roots.push({ path: common, available: false, ownership: 'unattributed', provenance: records.flatMap(record => record.provenance), owners: [] });
  }
}

async function checkpointStorage(discovery, measuredDirectories, checkpointRepository, git) {
  const categories = new Map(ids.map(id => [id, { id, byteSize: 0, itemCount: 0, directories: [], roots: [] }]));
  const warnings = [];
  const repositories = await collectRepositories(discovery, categories, warnings, checkpointRepository);

  for (const [common, records] of repositories) await inspectRepository(common, records, discovery, categories, measuredDirectories, warnings, git);

  return { categories, warnings };
}

module.exports = { checkpointStorage };
