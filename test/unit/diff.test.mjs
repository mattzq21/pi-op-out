import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from '../../src/lib/diff.ts';
import { turnDiff } from '../../src/lib/turnDiff.ts';

const patch = (path, before = 'const value = 1;', after = 'const value = 2;') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

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

test('turn diffs render daemon snapshots and tolerate absent patches', () => {
  for (const value of [undefined, '', { patch: '' }]) assert.deepEqual(turnDiff(value), { files: [], warnings: [] });
  const text = patch('a') + 'diff --git a/old b/new\nrename from old\nrename to new';
  for (const value of [text, { patch: text, repositoryRoot: '/repo' }]) {
    const result = turnDiff(value);
    assert.deepEqual(result.files.map(file => file.path), ['a', 'new']);
    assert.equal(result.files[0].additions, 1);
    assert.equal(result.files[0].deletions, 1);
    assert.deepEqual(result.warnings, []);
  }
});
