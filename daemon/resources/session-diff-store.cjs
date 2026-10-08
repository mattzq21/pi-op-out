const { readStoreLocked } = require('./session-broker/git-diff-store.cjs');

function sidecar(session) {
  if (!session.endsWith('.jsonl')) throw new Error('Invalid diff session filename');

  return session.replace(/\.jsonl$/, '.diffs.json');
}

function loadDiffs(session) { return readStoreLocked(sidecar(session)).snapshots; }

module.exports = { loadDiffs };
