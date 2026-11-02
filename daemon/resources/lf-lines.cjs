'use strict';

const { StringDecoder } = require('node:string_decoder');

// JSONL records end only at LF. node:readline also splits at CR, U+2028 and U+2029, which JSON strings may contain.
function splitter(emit) {
  const decoder = new StringDecoder('utf8');
  let parts = [];
  const push = text => {
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
    write: chunk => push(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    end: () => {
      push(decoder.end());
      const line = parts.join('');
      parts = [];
      if (line) emit(line.endsWith('\r') ? line.slice(0, -1) : line);
    },
  };
}

function readLines(input, onLine, onEnd) {
  const split = splitter(onLine);
  let ended = false;
  const finish = complete => {
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

async function* lines(input) {
  const ready = [];
  const split = splitter(line => ready.push(line));
  for await (const chunk of input) {
    split.write(chunk);
    yield* ready.splice(0);
  }
  split.end();
  yield* ready;
}

module.exports = { readLines, lines };
