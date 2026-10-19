const { Type } = require('typebox');
const { Check } = require('typebox/value');
const assets = require('./goal-assets.cjs');
const dependencies = require('./goal-dependencies.cjs');
const database = require('../session-database.cjs');

const contractSchema = Type.Object({ version: Type.Literal(1), policy: Type.Literal('shared-profile'), directories: Type.Array(Type.Object({ path: Type.String(), identity: Type.String() })) });

const textsSchema = Type.Array(Type.Object({ name: Type.String(), text: Type.String() }));

function addContract(root, contract, directories) {
  if (contract === undefined || contract === null) return;

  if (!Check(contractSchema, contract)) throw new Error('Invalid saved goal links; cleanup retained');

  for (const item of contract.directories) {
    if (!assets.validPath(root, item.path)) throw new Error('Saved goal link is outside managed storage');
    directories.add(item.path);
  }
}

function seeds(root, entries) {
  const directories = new Set();

  for (const entry of entries) {
    const { goalAssets, ...body } = entry;
    assets.directReferences([body], root).forEach(directory => directories.add(directory));
    addContract(root, goalAssets, directories);
  }

  return directories;
}

function saved(root, directory) {
  const expected = require('./goal-ownership.cjs').savedIdentity(root, directory);

  if (expected === undefined) return;
  const db = database.open(root);

  try {
    for (const table of ['goal_ownership', 'goal_text_contents']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return;
    }

    const rows = db.prepare(`SELECT d.record_json, t.contents_json FROM goal_asset_dependencies d
      JOIN goal_text_contents t USING(directory, identity) JOIN goal_ownership o USING(directory, identity)
      WHERE d.directory=? AND d.identity=? AND o.record_json IS NOT NULL`).all(directory, expected);

    if (rows.length > 1) throw new Error('More than one saved goal folder identity; cleanup retained');

    if (rows.length) return { contract: JSON.parse(rows[0].record_json ?? 'null'), texts: JSON.parse(rows[0].contents_json) };
  } finally { db.close(); }
}

function collect(root, entries) {
  return collectDirectories(root, seeds(root, entries));
}

function collectDirectories(root, initial) {
  const directories = new Set(initial);
  const texts = [];
  let incomplete = false;

  for (const directory of directories) {
    if (!assets.validPath(root, directory)) throw new Error('Goal link is outside managed storage');

    const record = assets.exists(directory)
      ? { contract: dependencies.read(root, directory), texts: dependencies.textContents(root, directory) }
      : saved(root, directory);

    if (!record) { incomplete = true; continue; }

    if (!Check(textsSchema, record.texts)) throw new Error('Invalid saved goal text; cleanup retained');
    texts.push(...record.texts.map(entry => entry.text));
    addContract(root, record.contract, directories);
    assets.directReferences(record.texts, root).forEach(reference => directories.add(reference));
  }

  return { directories, incomplete, texts };
}

module.exports = { collect, collectDirectories };
