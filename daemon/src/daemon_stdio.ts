import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { PEER_PROTOCOL_VERSION, PROTOCOL_VERSION } from './config';
import * as endpoint from './daemon_endpoint';
import * as daemonLog from './daemon_log';
import { daemonScript } from './session_worker';
import { sleep } from './util/sync';

function validateEndpoint(protocol: number, token: string, address: string): void {
  let url: URL;
  try { url = new URL(address); } catch (error: any) { throw new Error(error.message); }
  if (protocol !== PROTOCOL_VERSION || typeof token !== 'string' || token.length < 32 || url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('SSH must attach to a local Piop daemon endpoint');
  }
}

/** A WebSocket with a queue of received text messages. */
class Socket {
  private messages: string[] = [];
  private waiters: Array<(message: string | undefined) => void> = [];
  private closed = false;
  private onMessage: ((text: string) => void) | undefined;
  onClose: (() => void) | undefined;

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      if (this.onMessage) { this.onMessage(event.data); return; }
      const waiter = this.waiters.shift();
      if (waiter) waiter(event.data); else this.messages.push(event.data);
    });
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(undefined);
      this.onClose?.();
    };
    socket.addEventListener('close', close);
    socket.addEventListener('error', close);
  }

  listen(handler: (text: string) => void): void {
    this.onMessage = handler;
    for (const message of this.messages.splice(0)) handler(message);
  }

  next(): Promise<string | undefined> {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  send(text: string): void { this.socket.send(text); }
  /** Bytes accepted by send but not yet handed to the network. */
  bufferedAmount(): number { return this.socket.bufferedAmount; }
  close(): void { try { this.socket.close(); } catch {} }
}

async function openSocket(scope: string): Promise<[Socket, any]> {
  const current = endpoint.read();
  validateEndpoint(current.protocol, current.token, current.url);
  let socket: Socket | undefined;
  const attempt = (async (): Promise<[Socket, any]> => {
    const raw = new WebSocket(current.url);
    await new Promise<void>((resolve, reject) => {
      raw.addEventListener('open', () => resolve(), { once: true });
      raw.addEventListener('error', () => reject(new Error('Could not connect to ' + current.url)), { once: true });
    });
    socket = new Socket(raw);
    socket.send(JSON.stringify({ type: 'authenticate', token: current.token, scope }));
    const reply = await socket.next();
    if (reply === undefined) throw new Error('Daemon closed during authentication');
    const ready = JSON.parse(reply);
    if (ready?.type === 'error') throw new Error('Piop daemon rejected the connection: ' + (typeof ready.error === 'string' ? ready.error : 'unknown error'));
    if (ready?.type !== 'ready' || ready.peerProtocol !== PEER_PROTOCOL_VERSION || typeof ready.daemonId !== 'string') throw new Error('Upgrade the running Piop daemon to enable peer connections');
    return [socket, ready];
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([attempt, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Daemon handshake timed out')), 5000); })]);
  } catch (error) { socket?.close(); attempt.then(([opened]) => opened.close(), () => {}); throw error; }
  finally { clearTimeout(timer); }
}

async function tryOpen(scope: string): Promise<[Socket, any] | undefined> {
  try { return await openSocket(scope); } catch { return undefined; }
}

async function startDaemon(mode: string): Promise<[string, ChildProcess]> {
  const executable = daemonScript();
  const command: daemonLog.DaemonCommand = { program: executable, args: [mode], env: {} };
  const logPath = await daemonLog.configure(command, executable);
  return [logPath, await daemonLog.spawnDaemon(command)];
}

/**
 * Starts a daemon and opens a socket to it. When the new daemon exits because another daemon still holds
 * the lock, attaches to that daemon or starts again once after its lock is released.
 */
async function startAndOpen(mode: string, scope: string): Promise<[Socket, any]> {
  const deadline = Date.now() + endpoint.STARTUP_TIMEOUT;
  let logPath: string;
  let child: ChildProcess;
  let exit: number | null | undefined;
  const launch = async () => { [logPath, child] = await startDaemon(mode); exit = undefined; child.once('exit', code => { exit = code; }); };
  await launch();
  let relaunched = false;
  let lastError = '';
  while (Date.now() < deadline) {
    try { return await openSocket(scope); } catch (error: any) { lastError = error?.message ?? String(error); }
    if (exit !== undefined) {
      if (exit !== endpoint.ALREADY_RUNNING_EXIT_CODE || relaunched) throw new Error('Piop daemon exited with code ' + exit + '. See ' + logPath!);
      if (!claimed()) { await sleep(100); continue; }
      relaunched = true;
      await launch();
      continue;
    }
    await sleep(100);
  }
  throw new Error('Could not attach to Piop daemon: ' + lastError + '. See ' + logPath!);
}

async function connect(): Promise<[Socket, any]> {
  let opened = await tryOpen('peer');
  if (opened) return opened;
  while (endpoint.restartActive()) {
    await sleep(100);
    opened = await tryOpen('peer');
    if (opened) return opened;
  }
  return startAndOpen('--exit-on-disconnect', 'peer');
}

function claimed(): boolean {
  try { endpoint.claim().release(); return true; } catch { return false; }
}

async function controlSocket(action: string): Promise<Socket | undefined> {
  let opened = await tryOpen('control');
  if (opened) return opened[0];
  while (endpoint.restartActive()) {
    await sleep(100);
    opened = await tryOpen('control');
    if (opened) return opened[0];
  }
  if (action === 'stop' && claimed()) return undefined;
  if (action === 'start') return (await startAndOpen('--serve', 'control'))[0];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    opened = await tryOpen('control');
    if (opened) return opened[0];
    if (action === 'stop' && claimed()) return undefined;
    await sleep(100);
  }
  throw new Error('Could not contact the daemon. See ' + join(endpoint.directory(), 'daemon.log'));
}

async function sendControl(socket: Socket, action: string): Promise<void> {
  socket.send(JSON.stringify({ action }));
  const text = await socket.next();
  if (text === undefined) throw new Error('Daemon closed before confirming the command');
  const response = JSON.parse(text);
  if (response?.type === 'controlled' && response.action === action) return;
  throw new Error('The running daemon does not support start/stop control; restart it after upgrading');
}

async function waitUntilStopped(previous: endpoint.Endpoint): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (claimed()) return;
    try {
      const current = endpoint.read();
      if (current.url !== previous.url || current.token !== previous.token) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Daemon is still shutting down; check daemon.log');
}

/** Runs piopd start or piopd stop. */
export async function control(action: string): Promise<void> {
  const socket = await controlSocket(action);
  if (!socket) { console.log('Piop daemon is not running.'); return; }
  const current = endpoint.read();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([sendControl(socket, action), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Daemon control timed out; the running daemon may need upgrading')), 10_000); })]);
  } finally { clearTimeout(timer); socket.close(); }
  if (action === 'stop') await waitUntilStopped(current);
  console.log('Piop daemon ' + (action === 'start' ? 'running in the background' : 'stopped') + '.');
}

const INPUT_HIGH_WATER_BYTES = 16 * 1024 * 1024;
const INPUT_LOW_WATER_BYTES = 8 * 1024 * 1024;
const INPUT_STALL_MS = 60_000;

/** Runs --stdio-client: bridges stdin and stdout lines to the local daemon. */
export async function run(): Promise<void> {
  const [socket, ready] = await connect();
  const write = (text: string) => new Promise<void>((resolve, reject) => process.stdout.write(text + '\n', error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = Promise.resolve();
    let queuedBytes = 0;
    let failed = false;
    let paused = false;
    let inputPaused = false;
    let inputDrainTimer: NodeJS.Timeout | undefined;
    let inputStallTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    const heartbeat = setInterval(() => { try { socket.send(JSON.stringify({ type: 'ping' })); } catch {} }, 20_000);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      reject(error);
      clearTimeout(stallTimer);
      clearTimeout(inputDrainTimer);
      clearTimeout(inputStallTimer);
      clearInterval(heartbeat);
      socket.close();
      input.close();
    };
    // The WebSocket API has no drain event, so while input is paused the send buffer is checked on a short timer.
    const resumeInputWhenDrained = () => {
      if (failed) return;
      if (socket.bufferedAmount() > INPUT_LOW_WATER_BYTES) { inputDrainTimer = setTimeout(resumeInputWhenDrained, 50); return; }
      clearTimeout(inputStallTimer);
      inputPaused = false;
      input.resume();
    };
    const pauseInputUntilDrained = () => {
      if (inputPaused) return;
      inputPaused = true;
      input.pause();
      inputStallTimer = setTimeout(() => fail(new Error('Daemon stopped reading input: the send buffer did not drain for 60 seconds')), INPUT_STALL_MS);
      inputDrainTimer = setTimeout(resumeInputWhenDrained, 50);
    };
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      if (queuedBytes > 0 && !failed) stallTimer = setTimeout(() => fail(new Error('Daemon stdout reader stalled: no write completed for 60 seconds')), 60_000);
    };
    const enqueue = (text: string) => {
      if (failed) return;
      const bytes = Buffer.byteLength(text) + 1;
      const wasEmpty = queuedBytes === 0;
      queuedBytes += bytes;
      if (wasEmpty) resetStallTimer();
      if (queuedBytes > 16 * 1024 * 1024 && !paused) paused = socket.socket.pause();
      output = output.then(async () => {
        try { if (!failed) await write(text); } finally { queuedBytes -= bytes; }
        if (failed) return;
        resetStallTimer();
        if (paused && queuedBytes < 8 * 1024 * 1024) { socket.socket.resume(); paused = false; }
      }).catch(fail);
    };
    input.on('line', line => {
      if (failed) return;
      if (Buffer.byteLength(line) > 32 * 1024 * 1024) { fail(new Error('Daemon request is too large')); return; }
      try { socket.send(line); } catch (error) { fail(error); }
      if (socket.bufferedAmount() > INPUT_HIGH_WATER_BYTES) pauseInputUntilDrained();
    });
    input.on('close', () => { clearInterval(heartbeat); clearTimeout(inputDrainTimer); clearTimeout(inputStallTimer); socket.close(); output.then(() => resolve()); });
    socket.onClose = () => { clearInterval(heartbeat); clearTimeout(inputDrainTimer); clearTimeout(inputStallTimer); input.close(); output.then(() => resolve()); };
    enqueue(JSON.stringify(ready));
    socket.listen(enqueue);
  });
}
