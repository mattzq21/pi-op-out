const fs = require('node:fs');
const { readStoreLocked, requestStoreLocked } = require('./session-broker/git-diff-store.cjs');

function sidecar(session) {
  if (!session.endsWith('.jsonl')) throw new Error('Invalid diff session filename');

  return session.replace(/\.jsonl$/, '.diffs.json');
}

function loadDiffs(session) { return readStoreLocked(sidecar(session)).snapshots; }

function saveDiffs(session, incoming) { requestStoreLocked(sidecar(session), { action: 'merge', snapshots: incoming }); }

function pageCursor(cursor) {
  if (!cursor) return { sequence: 1, page: '' };
  const separator = cursor.indexOf(':');
  const sequence = Number(cursor.slice(0, separator));

  if (separator !== 20 || !Number.isSafeInteger(sequence) || sequence < 1 || sequence === Number.MAX_SAFE_INTEGER) throw new Error('Invalid diff page cursor; reload history');

  return { sequence: sequence + 1, page: cursor.slice(separator + 1) };
}

function collectFragment(part, current, snapshots) {
  const fragment = current || { id: part.messageId, body: '' };

  if (fragment.id !== part.messageId) throw new Error('Diff fragments changed message identity; preserved');
  fragment.body += part.content;

  if (Buffer.byteLength(fragment.body) > 4 * 1024 * 1024 * 6 + 64 * 1024) throw new Error('Diff fragment exceeds the saved record limit; preserved');

  if (!part.complete) return fragment;
  Object.defineProperty(snapshots, fragment.id, { value: JSON.parse(fragment.body), enumerable: true, configurable: true, writable: true });

  return undefined;
}

function loadDiffPage(session, cursor) {
  const position = pageCursor(cursor);
  const snapshots = Object.create(null); let fragment;

  for (;;) {
    const result = requestStoreLocked(sidecar(session), { action: 'page', cursor: position.page });
    Object.assign(snapshots, result.snapshots);

    if (result.fragment) fragment = collectFragment(result.fragment, fragment, snapshots);

    if (!fragment) return { snapshots, nextCursor: result.next === null ? null : `${String(position.sequence).padStart(20, '0')}:${result.next}` };

    if (result.next === null) throw new Error('Diff history ended with an incomplete snapshot; preserved');
    position.page = result.next;
  }
}

function runDiffStore(action, session) {
  if (action === 'load') return process.stdout.write(JSON.stringify(loadDiffs(session)));

  if (action === 'page') return process.stdout.write(JSON.stringify(loadDiffPage(session, process.argv[3] || '')));

  if (action !== 'save') throw new Error('Invalid diff storage operation');
  saveDiffs(session, JSON.parse(fs.readFileSync(0, 'utf8')));
}

module.exports = { loadDiffs, saveDiffs, runDiffStore };
