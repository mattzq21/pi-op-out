import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../../src/lib/diff.ts';
import { mergeDiffSnapshots, turnDiff } from '../../src/lib/turnDiff.ts';

const patch = (path, before = 'const value = 1;', after = 'const value = 2;') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const snapshot = (text, extra = {}) => ({ id: 'snapshot', cwd: '/repo', patch: text, paths: [], warnings: [], toolCallIds: [], ...extra });

test('unified diffs count lines and highlight only the changed tokens', () => {
  const [file] = parseDiff('ignored\n' + patch('a.ts'));
  assert.equal(file.path, 'a.ts');
  assert.equal(file.oldPath, 'a.ts');
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.equal(file.lines[1].oldLine, 1);
  assert.equal(file.lines[2].newLine, 1);
  assert.deepEqual(file.lines[1].parts, [{ text: 'const value = ', changed: false }, { text: '1', changed: true }, { text: ';', changed: false }]);
  assert.deepEqual(file.lines[2].parts, [{ text: 'const value = ', changed: false }, { text: '2', changed: true }, { text: ';', changed: false }]);
  const [context] = parseDiff('@@ -10,2 +20,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file', 'a');
  assert.deepEqual(context.lines[1], { kind: 'context', text: 'same', oldLine: 10, newLine: 20 });
  assert.equal(context.lines[2].oldLine, 11);
  assert.equal(context.lines[3].newLine, 21);
  assert.equal(context.lines[4].newLine, 22);
  assert.equal(context.lines[5].kind, 'meta');
  assert.deepEqual(parseDiff('nothing to show'), []);
});

test('diffs support renames, quoted Unicode paths, binary files, creation and deletion', () => {
  const [renamed] = parseDiff('diff --git "a/old name" "b/new name"\nsimilarity index 100%\nrename from "old name"\nrename to "new name"');
  assert.equal(renamed.oldPath, 'old name');
  assert.equal(renamed.path, 'new name');
  const [unicode] = parseDiff('diff --git "a/caf\\303\\251" "b/caf\\303\\251"');
  assert.equal(unicode.path, 'café');
  assert.equal(parseDiff('diff --git a/a "b/a\\tb\\nc\\rd\\\\e\\\"f\\q🦆"')[0].path, 'a\tb\nc\rd\\e"fq🦆');
  assert.equal(parseDiff('diff --git a/a b/a\nBinary files a/a and b/a differ')[0].lines[0].kind, 'meta');
  const [created] = parseDiff('--- /dev/null\n+++ new.txt\tdate\n@@ -0,0 +1 @@\n+new');
  assert.equal(created.path, 'new.txt');
  assert.equal(created.additions, 1);
  const [deleted] = parseDiff('--- old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old');
  assert.equal(deleted.path, 'old.txt');
  assert.equal(deleted.deletions, 1);
  assert.equal(parseDiff('diff --git b/only')[0].path, 'only');
  assert.equal(parseDiff('diff --git ')[0].path, '');
});

test('multiple header-only patches and hunk contents resembling headers stay distinct', () => {
  const files = parseDiff('--- old\n+++ new\n@@ -1 +1 @@\n--- old content\n+++ new content\n--- second\n+++ second\n@@ -3 +3 @@\n-a\n+b');
  assert.deepEqual(files.map(file => file.path), ['new', 'second']);
  assert.equal(files[0].lines[1].text, '-- old content');
  assert.equal(files[0].lines[2].text, '++ new content');
});

test('Codex patches and numbered edit output retain paths, operations and line numbers', () => {
  const files = parseDiff('*** Begin Patch\n*** Add File: a\n+hello\n*** Update File: b\n*** Move to: c\n@@ function\n-old\n+new\n unchanged\n*** Delete File: d\n*** End Patch');
  assert.deepEqual(files.map(file => file.path), ['a', 'c', 'd']);
  assert.equal(files[0].lines[1].newLine, 1);
  assert.equal(files[1].oldPath, 'b');
  assert.equal(files[1].additions, 1);
  assert.equal(files[1].deletions, 1);
  assert.equal(files[1].lines.at(-1).kind, 'context');
  const [numbered] = parseDiff('- 12 before\n+ 12 after\n  13 context', 'edit.txt');
  assert.deepEqual(numbered.lines.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine })), [
    { kind: 'delete', text: 'before', oldLine: 12, newLine: undefined },
    { kind: 'add', text: 'after', oldLine: undefined, newLine: 12 },
    { kind: 'context', text: 'context', oldLine: 13, newLine: 13 },
  ]);
});

test('intraline matching skips unrelated or excessive pairs and retains unchanged runs', () => {
  assert.equal(parseDiff(patch('a', 'one', 'completely different'))[0].lines[1].parts, undefined);
  assert.equal(parseDiff(patch('a', '', 'new'))[0].lines[1].parts, undefined);
  assert.deepEqual(parseDiff(patch('a', '', ''))[0].lines[1].parts, []);
  assert.deepEqual(parseDiff(patch('a', 'same', 'same'))[0].lines[1].parts, [{ text: 'same', changed: false }]);
  for (const [before, after] of [['a b', 'a x b'], ['a x b', 'a b'], ['color #fff', 'color #000']]) {
    const [, removed, added] = parseDiff(patch('a', before, after))[0].lines;
    assert.equal(removed.parts.map(part => part.text).join(''), before);
    assert.equal(added.parts.map(part => part.text).join(''), after);
    assert.ok([...removed.parts, ...added.parts].some(part => part.changed));
  }
  const many = 'diff --git a/a b/a\n@@ -1,21 +1,21 @@\n' + '-a\n'.repeat(21) + '+b\n'.repeat(21);
  assert.ok(parseDiff(many)[0].lines.every(line => !line.parts));
  assert.equal(parseDiff(patch('a', 'x'.repeat(4001), 'x'.repeat(4000) + 'y'))[0].lines[1].parts, undefined);
  const before = 'a '.repeat(150) + 'old suffix';
  const after = 'a '.repeat(150) + 'new suffix';
  const [, removed, added] = parseDiff(patch('a', before, after))[0].lines;
  assert.deepEqual(removed.parts, [{ text: 'a '.repeat(150), changed: false }, { text: 'old', changed: true }, { text: ' suffix', changed: false }]);
  assert.equal(added.parts[1].text, 'new');
});

test('diff rendering limits oversized input, lines and line counts', () => {
  const [longLine] = parseDiff(patch('a', 'old', 'x'.repeat(20001)));
  assert.equal(longLine.lines[2].text, 'x'.repeat(20000) + '…');
  const [many] = parseDiff('diff --git a/a b/a\n@@ -0,0 +1,10002 @@\n' + '+x\n'.repeat(10002));
  assert.equal(many.lines.length, 10001);
  assert.equal(many.additions, 10002);
  assert.match(many.lines.at(-1).text, /truncated/);
  const [bounded] = parseDiff('diff --git a/a b/a\n' + 'x'.repeat(4 * 1024 * 1024));
  assert.match(bounded.lines.at(-1).text, /truncated/);
});

test('merged snapshots prefer Git coverage including rename sources and retain untracked changes', () => {
  const git = { patch: patch('a') + 'diff --git a/old b/new\nrename from old\nrename to new', repositoryRoot: '/repo', toolPaths: [{ toolCallId: 'git' }] };
  const snapshots = [snapshot(patch('a') + patch('old') + patch('untracked'), { toolPaths: [{ toolCallId: 'tool' }] })];
  const merged = mergeDiffSnapshots(git, snapshots, '/elsewhere');
  assert.deepEqual(parseDiff(merged.patch).map(file => file.path), ['a', 'new', 'untracked']);
  assert.deepEqual(merged.toolPaths, [{ toolCallId: 'git' }, { toolCallId: 'tool' }]);
  assert.equal(merged.repositoryRoot, '/repo');
  assert.equal(mergeDiffSnapshots(null, [], '/repo'), null);
  assert.equal(mergeDiffSnapshots('', [snapshot('ignored')], '/repo'), null);
  assert.equal(mergeDiffSnapshots(patch('a'), [], '/repo').repositoryRoot, '/repo');
});

test('turn diffs combine subsequent changes and deduplicate warnings across snapshots', () => {
  const messages = [{ role: 'tool', fileChanges: [snapshot(patch('a'), { warnings: ['warning'] }), snapshot(patch('./a'), { warnings: ['warning', 'other'] }), snapshot(patch('../outside'))] }];
  const result = turnDiff(messages);
  assert.deepEqual(result.warnings, ['warning', 'other']);
  assert.deepEqual(result.files.map(file => file.path), ['a', '/outside']);
  assert.equal(result.files[0].additions, 2);
  assert.ok(result.files[0].lines.some(line => line.text === 'Subsequent changes'));
  assert.deepEqual(turnDiff([]), { files: [], warnings: [] });
  const git = turnDiff(messages, { patch: patch('a'), repositoryRoot: '/repo' });
  assert.equal(git.files[0].additions, 1);
});

test('turn diffs filter failed tools and prefer captured canonical files over tool patches', () => {
  const tool = { role: 'tool', id: 'call', toolName: 'namespace.edit', toolStatus: 'done', toolInput: { path: 'alias' }, details: { diff: '- 1 old\n+ 1 new' } };
  assert.equal(turnDiff([tool], undefined, '/repo').files[0].path, 'alias');
  for (const toolStatus of ['running', 'error']) assert.deepEqual(turnDiff([{ ...tool, toolStatus }]).files, []);
  assert.deepEqual(turnDiff([{ ...tool, role: 'assistant' }]).files, []);
  assert.deepEqual(turnDiff([{ ...tool, details: {} }]).files, []);
  const mapping = { toolCallId: 'call', path: 'alias', absolutePath: '/repo/alias', canonicalPath: '/repo/real' };
  const captured = snapshot(patch('real'), { toolCallIds: ['call'], paths: ['/repo/real'], toolPaths: [mapping] });
  assert.equal(turnDiff([{ ...tool, fileChanges: [captured] }]).files.length, 1);
  const mapped = turnDiff([tool], { patch: '', repositoryRoot: '/repo', toolPaths: [mapping] }, '/repo');
  assert.equal(mapped.files[0].id, '/repo/real');
  assert.equal(turnDiff([{ ...tool, toolInput: { path: './alias' } }], { patch: '', repositoryRoot: '/repo', toolPaths: [mapping] }, '/repo').files[0].id, '/repo/real');
  const apply = { role: 'tool', toolName: 'apply_patch', toolInput: { input: '*** Add File: /repo/new\n+hello\n*** End Patch' } };
  assert.equal(turnDiff([apply], '', '/repo/').files[0].path, 'new');
  assert.equal(turnDiff([{ ...apply, toolInput: { patch: patch('a') } }], '', '/repo').files[0].path, 'a');
  assert.equal(turnDiff([{ role: 'tool', details: { patch: patch('a') } }], '', '/repo').files[0].path, 'a');
  assert.equal(turnDiff([{ ...tool, fileChanges: [captured] }], { patch: 'diff --git a/real b/renamed\nrename from real\nrename to renamed', repositoryRoot: '/repo', toolPaths: [mapping] }).files.length, 1);
});
