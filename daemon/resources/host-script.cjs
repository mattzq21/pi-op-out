const fs = require('node:fs');

/** Returned by a script when a child process that runs this script again already wrote the reply, for example to hold the storage lock. */
const delegated = Symbol('host-script-delegated');
let requestText;

/** The request is read once from stdin, so a child process can receive the same text. */
function readRequestText() {
  requestText ??= fs.readFileSync(0, 'utf8');

  return requestText;
}

function failure(error) {
  const reply = { ok: false, error: error instanceof Error ? error.message : String(error) };

  if (typeof error?.state === 'string') reply.state = error.state;

  if (typeof error?.warning === 'string') reply.warning = error.warning;

  return reply;
}

/** Runs main with the JSON request from stdin and writes one reply: { ok: true, result } or { ok: false, error, state?, warning? }. */
function hostScript(main) {
  Promise.resolve()
    .then(() => main(JSON.parse(readRequestText())))
    .then(result => {
      if (result === delegated) return;
      process.stdout.write(JSON.stringify({ ok: true, result: result ?? null }));
    }, error => {
      process.stdout.write(JSON.stringify(failure(error)));
      process.exitCode = 1;
    });
}

module.exports = { hostScript, readRequestText, delegated };
