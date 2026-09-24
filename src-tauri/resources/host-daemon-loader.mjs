import { readSync } from 'node:fs';

function readExactly(length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, buffer, offset, length - offset, null);
    if (count === 0) throw new Error('Host daemon source was incomplete');
    offset += count;
  }
  return buffer;
}

const length = readExactly(4).readUInt32BE();
if (length > 32 * 1024 * 1024) throw new Error('Host daemon source exceeds the size limit');
const source = readExactly(length);
// Read only the source frame, leaving subsequent RPC lines on stdin.
await import(`data:text/javascript;base64,${source.toString('base64')}`);
