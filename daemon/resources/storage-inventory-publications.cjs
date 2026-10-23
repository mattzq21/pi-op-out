const fs = require('node:fs/promises');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { retainedDependencies } = require('./piop-storage/session-publication.cjs');
const { addRoot } = require('./storage-inventory-roots.cjs');
const { createObservation, observeEntry, recordGoals } = require('./storage-inventory-owners.cjs');

const journalSchema = Type.Object({ kind: Type.Literal('session-publication'), root: Type.String(), id: Type.String(), sessionId: Type.String(), bytes: Type.Integer({ minimum: 1 }), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), target: Type.String(), temporary: Type.String(), quarantine: Type.Optional(Type.Object({ path: Type.String() })) });

function artifact(discovery, file, diagnostic, category, provenance, expectedIdentity) {
  const owner = { sessionId: diagnostic.sessionId, sessionPath: diagnostic.journalPath, kind: 'diagnostic-publication' };
  const record = addRoot(discovery.retainedArtifacts, file, provenance + '; diagnostic reference, not a live owner', 'owned', [owner]);
  record.category = category;
  record.state = 'publication-diagnostic';
  record.expectedIdentity = expectedIdentity;

  return record;
}

function contractGoals(diagnostic, discovery) {
  if (!diagnostic.dependencies) return;
  const observation = createObservation();
  observeEntry(observation, { goalAssets: diagnostic.dependencies.goalAssets });
  const kind = 'diagnostic-publication-contract';
  recordGoals(discovery, { observation, readable: true }, { sessionId: diagnostic.sessionId, sessionPath: diagnostic.journalPath, kind }, { file: diagnostic.journalPath, kind });
}

function journalProof(profile, diagnostic) {
  const journal = require('./session-database.cjs').publication(profile, path.basename(diagnostic.journalPath, '.json'));

  if (!Check(journalSchema, journal) || journal.root !== profile || journal.sessionId !== diagnostic.sessionId || diagnostic.journalPath !== path.join(profile, 'session-publications', journal.id + '.json')) throw new Error('Publication journal changed after verified enumeration');

  if (JSON.stringify(journal.dependencies) !== JSON.stringify(diagnostic.dependencies)) throw new Error('Publication dependency contract changed after verified enumeration');

  return journal;
}

async function transcripts(diagnostic, journal, discovery, transcript) {
  const candidates = new Set([journal.target, journal.temporary, journal.quarantine?.path]);

  for (const file of diagnostic.transcriptPaths) {
    try {
      if (!candidates.has(file)) throw new Error('Publication transcript mapping changed after verified enumeration');
      await transcript(file, { sessionId: diagnostic.sessionId, publicationId: journal.id, bytes: journal.bytes, digest: journal.digest }, discovery, 'diagnostic-publication-transcript');
      const category = file.startsWith(path.join(journal.root, 'sessions') + path.sep) ? 'active-conversations' : 'other-storage';
      artifact(discovery, file, diagnostic, category, 'Exact-digest publication transcript from ' + diagnostic.journalPath);
    } catch (error) { discovery.warnings.push(file + ': publication transcript diagnostic coverage unavailable: ' + error.message); }
  }
}

async function namespaces(profile, discovery) {
  for (const name of ['session-publications', 'session-publication-locks', 'session-publication-quarantine']) {
    const directory = path.join(profile, name);

    try {
      const metadata = await fs.lstat(directory);

      if (!metadata.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Publication namespace has ambiguous ancestry');
      const record = addRoot(discovery.retainedArtifacts, directory, 'Publication diagnostic namespace; regular files counted in other storage; no live owner inference', 'owned');
      record.category = 'other-storage';
      record.state = 'publication-diagnostics';
    } catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(directory + ': publication namespace coverage unavailable: ' + error.message); }
  }
}

async function discoverPublicationDiagnostics(profile, discovery, transcript) {
  await namespaces(profile, discovery);
  let diagnostics;

  try { diagnostics = retainedDependencies(profile); }
  catch (error) {
    discovery.warnings.push(profile + ': publication diagnostic dependency coverage unavailable: ' + error.message + '; retained journals and assets require reconciliation');

    return;
  }

  for (const diagnostic of diagnostics) {
    contractGoals(diagnostic, discovery);

    try { await transcripts(diagnostic, journalProof(profile, diagnostic), discovery, transcript); }
    catch (error) { discovery.warnings.push(diagnostic.journalPath + ': publication transcript coverage unavailable: ' + error.message); }
  }
}

module.exports = { discoverPublicationDiagnostics };
