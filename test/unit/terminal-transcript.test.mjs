import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalTranscript } from '../../clients/ui/lib/terminalTranscript.ts';

test('a progress line redrawn across output chunks shows only its latest state', () => {
  const transcript = createTerminalTranscript();
  transcript.append('$ npm install\nfetching 10%\r');
  transcript.append('fetching 55%\r');
  assert.equal(transcript.append('fetching 100%\r\ndone\n'), '$ npm install\nfetching 100%\ndone\n');
});

test('colored output is shown as plain text split into styled runs', () => {
  const transcript = createTerminalTranscript();
  assert.equal(transcript.append('ok \u001b[1;31mFAIL\u001b[0m end'), 'ok FAIL end');
  assert.deepEqual(transcript.segments().map(({ text, style }) => [text, style.color, style['font-weight']]), [
    ['ok ', '#e5e1d8', undefined],
    ['FAIL', '#ef2929', 'bold'],
    [' end', '#e5e1d8', undefined],
  ]);
});

test('window title and cursor control sequences are hidden, even when split across chunks', () => {
  const transcript = createTerminalTranscript();
  transcript.append('\u001b]0;matt@box: ~/re');
  transcript.append('po\u0007\u001b[?2004h$ ls\n');
  transcript.append('\u001b]633;A\u001b');
  assert.equal(transcript.append('\\$ '), '$ ls\n$ ');
});

test('shell line editing removes whole characters and redraws cleared lines', () => {
  const transcript = createTerminalTranscript();
  transcript.append('$ echo 👍');
  assert.equal(transcript.append('\b\u001b[K'), '$ echo ');
  assert.equal(transcript.append('\r\u001b[K$ ls'), '$ ls');
  assert.equal(transcript.append('\n\b\b'), '$ ls\n', 'backspace never joins the previous line');
});

test('output beyond the size limit drops the oldest text and keeps colors aligned', () => {
  const transcript = createTerminalTranscript();
  const limit = 4 * 1024 * 1024;
  transcript.append('old line\n\u001b[32m');
  const text = transcript.append('g'.repeat(limit - 3) + '\u001b[0m tail');
  assert.equal(text.length, limit);
  assert.ok(text.endsWith('gg tail'));
  assert.ok(!text.includes('old'));
  assert.deepEqual(transcript.segments().map(({ text, style }) => [text.length, style.color]), [[limit - 5, '#72ad8d'], [5, '#e5e1d8']]);
});
