const fs = require('node:fs');

// Pi's link to the daemon for storage changes: one request line out, one answer line back, on the descriptor in
// PIOP_STORAGE_CHANNEL. A call waits for its answer, so a change is saved or has failed when the call returns, as with a direct write.
// Each Pi extension is one file with its own copy of this module. All copies use the channel that the first one took.
const CLAIMED = Symbol.for('piop.storage-channel');

// Takes the channel from the environment once, so that the programs this process starts do not get it.
function claim() {
  const claimed = Object.getOwnPropertyDescriptor(globalThis, CLAIMED);
  if (claimed) return claimed.value;
  const configured = process.env.PIOP_STORAGE_CHANNEL;
  delete process.env.PIOP_STORAGE_CHANNEL;
  const value = configured === undefined || configured === '' ? null : Number(configured);
  if (value !== null && (!Number.isSafeInteger(value) || value < 3 || !fs.fstatSync(value).isSocket())) throw new Error('The Piop storage channel is not open');
  Object.defineProperty(globalThis, CLAIMED, { value });
  return value;
}

// True in a process that the daemon started with a storage channel. Such a process asks the daemon for every change.
function hasChannel() { return claim() !== null; }

function channel() {
  const descriptor = claim();
  if (descriptor === null) throw new Error('Pi was not started by the Piop daemon, so it cannot save');
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
    for (const flag of ['damaged', 'publicationPending', 'dependenciesRetained']) if (answer[flag] === true) error[flag] = true;
    throw error;
  }
  if (!answer || !Object.hasOwn(answer, 'result')) throw new Error('The Piop daemon sent an invalid storage answer');
  return answer.result;
}

// The transcript writes of session-storage.mjs, run by the daemon.
const transcriptWrites = Object.fromEntries(['publish', 'append', 'repair', 'bind', 'selectBranch', 'copyGoal']
  .map(name => [name, request => call('transcript.' + name, request)]));

module.exports = { call, claim, hasChannel, transcriptWrites };
