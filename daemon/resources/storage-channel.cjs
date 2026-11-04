const fs = require('node:fs');

// Pi's link to the daemon for storage changes: one request line out, one answer line back, on the descriptor in
// PIOP_STORAGE_CHANNEL. A call waits for its answer, so a change is saved or has failed when the call returns, as with a direct write.
let descriptor;

function channel() {
  if (descriptor !== undefined) return descriptor;
  const value = Number(process.env.PIOP_STORAGE_CHANNEL);
  if (!Number.isSafeInteger(value) || value < 3) throw new Error('Pi was not started by the Piop daemon, so it cannot save chats');
  if (!fs.fstatSync(value).isSocket()) throw new Error('The Piop storage channel is not open');
  descriptor = value;
  return descriptor;
}

function writeAll(fd, body) {
  for (let offset = 0; offset < body.length;) offset += fs.writeSync(fd, body, offset);
}

function readLine(fd) {
  const parts = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const length = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (length === 0) throw new Error('The Piop daemon closed the storage channel');
    const newline = buffer.indexOf(10);
    if (newline >= 0 && newline < length) {
      if (newline !== length - 1) throw new Error('The Piop daemon sent more than one storage answer');
      parts.push(Buffer.from(buffer.subarray(0, newline)));
      return Buffer.concat(parts).toString('utf8');
    }
    parts.push(Buffer.from(buffer.subarray(0, length)));
  }
}

function call(operation, payload) {
  const fd = channel();
  writeAll(fd, Buffer.from(JSON.stringify({ operation, payload }) + '\n'));
  const answer = JSON.parse(readLine(fd));
  if (typeof answer?.error === 'string') {
    const error = new Error(answer.error);
    if (answer.damaged === true) error.damaged = true;
    throw error;
  }
  if (!answer || !Object.hasOwn(answer, 'result')) throw new Error('The Piop daemon sent an invalid storage answer');
  return answer.result;
}

// The transcript writes of session-storage.mjs, run by the daemon.
const transcriptWrites = Object.fromEntries(['publish', 'append', 'repair', 'bind', 'selectBranch', 'copyGoal']
  .map(name => [name, request => call('transcript.' + name, request)]));

module.exports = { call, transcriptWrites };
