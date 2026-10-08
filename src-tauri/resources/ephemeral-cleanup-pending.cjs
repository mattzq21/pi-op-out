const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { readStore } = require('./session-broker/git-diff-store.cjs');
const files = require('./ephemeral-cleanup-files.cjs');
const { inspectTransfer } = require('./diff-transfer-provenance.cjs');

const captureSchema = Type.Union([
  Type.Object({ cwd: Type.String(), baseline: Type.String(), current: Type.String(), ready: Type.Boolean() }),
  Type.Object({ source: Type.Literal('copy'), ready: Type.Literal(true) }),
]);

const pointerSchema = Type.Object({ sessionId: Type.String(), id: Type.String(), capture: captureSchema });

const tokenSchema = Type.Object({ root: Type.String(), repository_root: Type.String(), tree: Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }) });

function comparison(token, parent) {
  const value = JSON.parse(token);

  if (!Check(tokenSchema, value) || !path.isAbsolute(value.root) || path.dirname(value.root) !== parent || !path.basename(value.root).startsWith('pi-desktop-diff-')) throw new Error('Pending global comparison identity is invalid; cleanup retained');
  const metadata = files.exists(value.root);

  if (metadata && (!metadata.isDirectory() || fs.realpathSync(value.root) !== value.root)) throw new Error('Pending comparison directory identity changed; cleanup retained');

  return { ...value, available: Boolean(metadata), identity: metadata ? files.identity(value.root) : null };
}

function retained(source, id, capture, parent) {
  if (!Check(captureSchema, capture)) throw new Error('Invalid pending comparison metadata; cleanup retained');

  if (capture.source === 'copy') return { source, id, copy: true };

  return { source, id, baseline: comparison(capture.baseline, parent), current: comparison(capture.current, parent), ready: capture.ready };
}

function pointers(parent, sessionId) {
  if (!files.exists(parent)) return [];
  const records = [];

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith('pi-desktop-diff-')) continue;
    const directory = path.join(parent, entry.name);
    const pointer = path.join(directory, 'pending-diff.json');

    if (!files.exists(pointer)) continue;

    if (!entry.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Pending comparison storage is unavailable or changed: ${directory}`);
    const record = files.read(pointer);

    if (!Check(pointerSchema, record)) throw new Error(`Pending comparison provenance is invalid; retained: ${pointer}`);

    if (record.sessionId === sessionId) records.push(retained(pointer, record.id, record.capture, parent));
  }

  return records;
}

function inspect(file, sessionId, profile) {
  const diffFile = file.replace(/\.jsonl$/, '.diffs.json');
  const parent = path.join(profile, 'git-snapshots');
  const records = pointers(parent, sessionId);
  const state = readStore(diffFile, false);

  for (const [id, capture] of Object.entries(state.pending)) records.push(retained(diffFile, id, capture, parent));
  retainedTransfers(state, diffFile, sessionId, profile, records);

  return records;
}

function retainedTransfers(state, source, sessionId, profile, records) {
  for (const [key, value] of Object.entries(state.transfers)) {
    const { transfer, file, metadata } = inspectTransfer(profile, key, value);

    if (transfer.committed && !metadata) continue;

    if (transfer.owner !== sessionId) throw new Error('Pending diff transfer belongs to another conversation; source log and staging retained');
    records.push({ source, id: transfer.messageId, transferId: transfer.transferId, path: file, offset: transfer.offset, committed: transfer.committed, available: Boolean(metadata), identity: metadata?.identity ?? null });
  }
}

module.exports = { inspect };
