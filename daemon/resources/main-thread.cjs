const { receiveMessageOnPort } = require('node:worker_threads');

// The daemon's main thread is the only thread that changes the storage database. Worker threads do the slow file
// work and the reads. Each database change that a worker needs runs on the main thread, and the worker waits for it.
const OPERATIONS = Symbol.for('piop.main-thread-operations');
const LINK = Symbol.for('piop.main-thread-link');

// A worker reads inside a transaction from one snapshot. A change that the main thread makes then would be outside
// that transaction, and the worker would not see it, so a worker asks for changes only outside transactions.
let openTransactions = 0;

function holdTransaction() {
  openTransactions++;
  let held = true;
  return () => { if (held) { held = false; openTransactions--; } };
}

function operations() {
  if (!Object.hasOwn(globalThis, OPERATIONS)) Object.defineProperty(globalThis, OPERATIONS, { value: new Map() });
  return globalThis[OPERATIONS];
}

// Names a database change. Called on the main thread, it runs at once. Called on a worker thread, the worker sends
// the name and the arguments to the main thread and waits for the result. Arguments and results must be plain data.
// A request that changes no data (inTransaction) may also be sent from inside a transaction.
function onMainThread(name, operation, { inTransaction = false } = {}) {
  operations().set(name, operation);
  if (inTransaction) anywhere.add(name);
  return (...args) => {
    const link = Object.getOwnPropertyDescriptor(globalThis, LINK)?.value;
    return link ? link(name, args) : operation(...args);
  };
}

const anywhere = new Set();

// The worker whose request the main thread runs now, while the request starts; undefined for the main thread's own calls.
let caller;

function currentCaller() { return caller; }

const FAILURE_FIELDS = ['code', 'damaged', 'publicationPending', 'dependenciesRetained'];

// In a worker thread: sends each change on port, and waits on signal until the main thread has answered.
function connectWorker(port, signal) {
  const flag = new Int32Array(signal);
  Object.defineProperty(globalThis, LINK, { value: (name, args) => {
    if (openTransactions && !anywhere.has(name)) throw new Error('A worker thread asked for the database change ' + name + ' inside a transaction');
    Atomics.store(flag, 0, 0);
    port.postMessage({ name, args });
    // The wake-up of an earlier answer can come late, during this wait, so the worker waits until the flag is set.
    while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
    const answer = receiveMessageOnPort(port)?.message;
    if (!answer) throw new Error('The daemon main thread did not answer ' + name);
    if (answer.error === undefined) return answer.result;
    throw Object.assign(new Error(answer.error), answer.fields);
  } });
}

// On the main thread: runs the changes that one worker sends on port, one at a time, and wakes the worker after each.
let serving = false;

// A worker gets an end list: what it still holds when it ends (such as locks) is given back then.
function serveWorker(port, signal) {
  serving = true;
  const flag = new Int32Array(signal);
  const worker = { ended: false, end: new Set() };
  port.on('close', () => {
    worker.ended = true;
    for (const finish of [...worker.end]) { try { finish(); } catch (error) { console.error('Could not give back what a stopped worker held: ' + (error?.message ?? error)); } }
    worker.end.clear();
  });
  port.on('message', async ({ name, args }) => {
    let answer;
    try {
      const operation = operations().get(name);
      if (!operation) throw new Error('Unknown database change: ' + name);
      caller = worker;
      let pending;
      try { pending = operation(...args); } finally { caller = undefined; }
      answer = { result: await pending };
    } catch (error) {
      const fields = Object.fromEntries(FAILURE_FIELDS.filter(field => error?.[field] !== undefined).map(field => [field, error[field]]));
      answer = { error: error instanceof Error ? error.message : String(error), fields };
    }
    try { port.postMessage(answer); }
    catch (error) { port.postMessage({ error: 'Could not send the result of ' + name + ': ' + error.message, fields: {} }); }
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
}

// True in a worker thread whose database changes run on the main thread. Such a thread opens the database read-only.
function linkedWorker() { return Object.hasOwn(globalThis, LINK); }

// True on the daemon's main thread once it runs changes for workers. It must not wait for a lock that a worker holds:
// that worker may itself wait for the main thread.
function servesWorkers() { return serving; }

module.exports = { onMainThread, connectWorker, serveWorker, linkedWorker, holdTransaction, servesWorkers, currentCaller };
