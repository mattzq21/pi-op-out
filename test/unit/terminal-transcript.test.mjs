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

test('a history redraw that moves the cursor over the prompt keeps the prompt', () => {
  const transcript = createTerminalTranscript();
  const prompt = 'matt@mattPC:~/proj/piop$ ';
  const overPrompt = '\r' + '\u001b[C'.repeat(prompt.length);
  transcript.append(prompt + 'echo a very long command here to recall');
  // Bash output when the up key recalls a shorter command, captured from a real shell.
  const recalled = "PS1='matt@mattPC:~/proj/piop$ '";
  assert.equal(transcript.append(overPrompt + '\u001b[8P' + recalled), prompt + recalled);
  assert.equal(transcript.currentLine(), prompt + recalled);
  assert.equal(transcript.append(overPrompt + '\u001b[K'), prompt, 'end of history leaves only the prompt');
});

test('cursor moves inside a line edit the text where the cursor is', () => {
  const transcript = createTerminalTranscript();
  transcript.append('$ abcd');
  assert.equal(transcript.append('\u001b[3DX'), '$ aXcd', 'text at the cursor is written over');
  assert.equal(transcript.append('\u001b[2@YZ'), '$ aXYZcd', 'inserted blanks move the rest of the line right');
  assert.equal(transcript.append('\u001b[1G\u001b[2X'), '  aXYZcd', 'erased characters become blanks');
  assert.equal(transcript.append('\u001b[20Ge'), '  aXYZcd' + ' '.repeat(11) + 'e', 'text past the end of the line is padded');
});

test('output beyond the size limit drops the oldest text and keeps colors aligned', () => {
  const transcript = createTerminalTranscript();
  const limit = 4 * 1024 * 1024;
  transcript.append('old line\n\u001b[32m');
  const text = transcript.append('g'.repeat(limit - 3) + '\u001b[0m tail');
  assert.equal(text.length, limit);
  assert.ok(text.endsWith('gg tail'));
  assert.ok(!text.includes('old'));
  const colors = transcript.segments().reduce((parts, { text, style }) => {
    if (parts.at(-1)?.[1] === style.color) parts.at(-1)[0] += text.length;
    else parts.push([text.length, style.color]);
    return parts;
  }, []);
  assert.deepEqual(colors, [[limit - 5, '#72ad8d'], [5, '#e5e1d8']]);
});

test('a history redraw of a command longer than the terminal width keeps the prompt and the whole command', () => {
  const transcript = createTerminalTranscript();
  const prompt = 'matt@mattPC:~/.piop-dev/tmp/2974b710-efa0-4325-a013-d71584a78669$ ';
  const right = count => '\u001b[C'.repeat(count);
  transcript.append('\u001b[8;24;80t' + prompt);
  // Bash output in an 80 column terminal for three up keys, captured from a real shell. The first entry wraps to a second row.
  transcript.append('echo mid length');
  assert.equal(transcript.currentLine(), prompt + 'echo mid length');
  transcript.append('\u001b[A' + right(65) + 'ls\u001b[K\r\n\r\u001b[K\u001b[A' + right(68));
  assert.equal(transcript.currentLine(), prompt + 'ls');
  assert.equal(transcript.append(''), prompt + 'ls', 'the emptied second row is not shown');
  transcript.append('\b\becho a very long command here to recall');
  assert.equal(transcript.currentLine(), prompt + 'echo a very long command here to recall');
  assert.equal(transcript.segments(prompt.length).map(segment => segment.text).join(''), prompt, 'a line limit hides the command after the prompt');
  transcript.append('\u001b[A' + right(41) + '\u001b[K\r\n\r\u001b[K\u001b[A' + right(66));
  assert.equal(transcript.append(''), prompt, 'end of history leaves only the prompt');
});
