#!/usr/bin/env node
'use strict';

// E2E-only process gate. Piop's bridge can accept app requests before its SDK
// session is bound. Buffer input in the pipe until real Pi answers get_state.
// native_startup.test.ts deliberately uses normal launch and retains that bug.
// Usage: node pi-ready-launcher.cjs --node /absolute/real/node -- <original Node args>
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isAbsolute, basename } = require('node:path');
const { Transform } = require('node:stream');

const argv = process.argv.slice(2);
if (argv[0] !== '--node' || !isAbsolute(argv[1] || '') || argv[2] !== '--' || argv.length < 4) {
  console.error('Usage: pi-ready-launcher.cjs --node /absolute/real/node -- <Node arguments>');
  process.exitCode = 2;
} else {
  run(argv[1], argv.slice(3));
}

function run(node, args) {
  const timeout = Number(process.env.PIOP_E2E_READY_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) {
    console.error('PIOP_E2E_READY_TIMEOUT_MS must be an integer from 1 to 120000');
    process.exitCode = 2;
    return;
  }
  const id = 'piop-e2e-ready-' + randomUUID();
  let waiting = basename(args[0]) === 'runtime-bridge.cjs' && !args.includes('--print');
  let readyTimer, killTimer, failed = false, closing = false;
  let partial = Buffer.alloc(0);
  const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true });

  function signal(value) {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); }
    catch (error) { if (error.code !== 'ESRCH') fail('Could not signal Pi: ' + error.message); }
  }
  function stop(value = 'SIGTERM') {
    if (closing) return;
    closing = true;
    clearTimeout(readyTimer);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    signal(value);
    killTimer = setTimeout(() => signal('SIGKILL'), 2000);
  }
  function fail(message) {
    if (!failed) console.error('Pi readiness launcher: ' + message);
    failed = true;
    stop();
  }
  function release() {
    waiting = false;
    clearTimeout(readyTimer);
    if (!closing) process.stdin.pipe(child.stdin);
  }

  // Transform and pipe preserve stdout backpressure. Before readiness, only
  // complete JSON lines are inspected; every other byte is forwarded unchanged.
  const output = new Transform({
    transform(chunk, _encoding, done) {
      if (!waiting) { this.push(chunk); done(); return; }
      partial = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      let newline;
      while ((newline = partial.indexOf(10)) >= 0) {
        const line = partial.subarray(0, newline + 1);
        partial = partial.subarray(newline + 1);
        let packet;
        try { packet = JSON.parse(line.toString('utf8')); } catch {}
        if (packet?.type === 'response' && packet.id === id) {
          if (packet.success !== true) { fail('Native get_state failed: ' + String(packet.error ?? 'no success response')); }
          else release();
          if (!waiting) { if (partial.length) this.push(partial); partial = Buffer.alloc(0); break; }
        } else this.push(line);
      }
      if (partial.length > 128 * 1024 * 1024) fail('Pi emitted an oversized line before readiness');
      done();
    },
    flush(done) { if (partial.length) this.push(partial); partial = Buffer.alloc(0); done(); },
  });
  child.stdout.pipe(output).pipe(process.stdout, { end: false });
  output.on('error', error => fail('Pi output failed: ' + error.message));
  process.stdout.on('error', error => fail('Output closed: ' + error.message));
  process.stdin.on('error', error => fail('Input failed: ' + error.message));
  child.stdin.on('error', error => { if (!closing) fail('Pi input closed: ' + error.message); });
  child.stdout.on('error', error => fail('Pi output closed: ' + error.message));
  child.once('error', error => fail('Could not start Pi: ' + error.message));
  const handlers = new Map();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => stop(name);
    handlers.set(name, handler);
    process.on(name, handler);
  }
  child.once('close', (code, receivedSignal) => {
    clearTimeout(readyTimer);
    clearTimeout(killTimer);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.stdin.destroy();
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (waiting && !closing) { failed = true; console.error('Pi readiness launcher: Pi exited before its readiness response'); }
    // Allow queued stdout to drain before exit. Preserve the child's exit code
    // or signal unless this launcher itself encountered a protocol/I/O failure.
    if (receivedSignal && !failed) process.stdout.write('', () => process.kill(process.pid, receivedSignal));
    else process.exitCode = failed ? 1 : (code ?? 1);
  });
  if (waiting) {
    readyTimer = setTimeout(() => fail('Native get_state did not answer within ' + timeout + ' ms'), timeout);
    child.stdin.write(JSON.stringify({ type: 'get_state', id }) + '\n');
  } else release();
}
