import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

// JSONL records end only at LF. node:readline also splits at CR, U+2028 and U+2029, which JSON strings may contain.
function splitter(emit: (line: string) => void) {
  const decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  const push = (text: string) => {
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      parts.push(text.slice(start, end));
      const line = parts.join('');
      parts = [];
      start = end + 1;
      emit(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (start < text.length) parts.push(text.slice(start));
  };
  return {
    write: (chunk: string | Buffer) => push(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    end: () => {
      push(decoder.end());
      const line = parts.join('');
      parts = [];
      if (line) emit(line.endsWith('\r') ? line.slice(0, -1) : line);
    },
  };
}

function readLines(input: Readable, onLine: (line: string) => void, onEnd?: () => void): () => void {
  const split = splitter(onLine);
  let ended = false;
  const finish = (complete: boolean) => {
    if (ended) return;
    ended = true;
    input.off('data', split.write);
    if (complete) split.end();
    onEnd?.();
  };
  input.on('data', split.write);
  input.once('end', () => finish(true));
  input.once('close', () => finish(false));
  return () => { finish(false); input.pause(); };
}

async function* lines(input: Readable): AsyncGenerator<string> {
  const ready: string[] = [];
  const split = splitter(line => ready.push(line));
  for await (const chunk of input) {
    split.write(chunk);
    yield* ready.splice(0);
  }
  split.end();
  yield* ready;
}

// The first line of the file path, with its LF, read without the rest of the file. At most limit bytes.
function readHeaderLine(path: string, limit = 64 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(fd, buffer, length, limit - length, null);
      if (count === 0) break;
      const newline = buffer.subarray(length, length + count).indexOf(10);
      length += count;
      if (newline >= 0) { length = length - count + newline + 1; break; }
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

export { readLines, lines, readHeaderLine };
