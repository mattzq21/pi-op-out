import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hiddenDisplayEnv, startHiddenDisplay } from '../hidden-display.mjs';

const miniBrowser = process.env.PIOP_TEST_MINIBROWSER ?? '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser';

let configDirectory;

/** A GTK configuration that shrinks MiniBrowser's toolbar to almost nothing, so the window can be as narrow as a phone; otherwise the toolbar keeps the viewport at least 447 pixels wide. */
function gtkConfig() {
  configDirectory ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'piop-minibrowser-'));
    process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'gtk-3.0'));
    await writeFile(join(directory, 'gtk-3.0', 'gtk.css'), '* { min-width: 0; min-height: 0; padding: 0; margin: 0; border-width: 0; font-size: 1px; }\nimage { -gtk-icon-transform: scale(0.01); }\n');
    return directory;
  })();
  return configDirectory;
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const listening = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port }, () => { socket.end(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/** A helper process on the hidden screen that answers one JSON line per JSON command line. request({ action, ... }) answers in order. */
async function lineHelper(name, executable, args, waitForReady, display) {
  const helper = spawn(executable, [fileURLToPath(new URL(name, import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: await hiddenDisplayEnv(process.env, display) });
  helper.unref();
  helper.stdin.unref?.();
  process.once('exit', () => helper.kill());
  const waiting = [];
  // The helper keeps the test process alive only while an answer is pending.
  const track = () => { if (waiting.length) helper.stdout.ref?.(); else helper.stdout.unref?.(); };
  const exited = new Promise((_, reject) => helper.once('exit', code => reject(new Error(name + ' exited with ' + code))));
  exited.catch(() => undefined);
  createInterface({ input: helper.stdout }).on('line', line => { waiting.shift()?.(JSON.parse(line)); track(); });
  if (waitForReady) { const ready = new Promise(resolve => waiting.push(resolve)); track(); await Promise.race([ready, exited]); }
  track();
  let queue = Promise.resolve();
  return {
    close: () => helper.kill(),
    request(command) {
      const answer = queue.then(() => Promise.race([exited, new Promise((resolve, reject) => {
        waiting.push(reply => reply.ok ? resolve(reply.value) : reject(new Error(name + ': ' + reply.error)));
        track();
        helper.stdin.write(JSON.stringify(command) + '\n');
      })]));
      queue = answer.catch(() => undefined);
      return answer;
    },
  };
}


export class WebDriverError extends Error {
  constructor(error, message) { super(error + ': ' + message); this.error = error; this.name = 'WebDriverError'; }
}

/**
 * A MiniBrowser session through WebKitWebDriver. Commands run one at a time; each names the window it acts on.
 * options: { proxy: string, scale?: number }.
 */
export async function startSession({ proxy, scale = 1 }) {
  // Each session has its own screen, so tests that run at once share no focus, pointer or window stack.
  const display = await startHiddenDisplay();
  const port = await freePort();
  // Playwright's browser contexts default to the en-US locale.
  const env = { ...await hiddenDisplayEnv(process.env, display.name), GDK_SCALE: String(scale), XDG_CONFIG_HOME: await gtkConfig(), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LANGUAGE: 'en_US', GTK_IM_MODULE: 'gtk-im-context-simple', XMODIFIERS: '' };
  const driver = spawn('WebKitWebDriver', ['--port=' + port], { stdio: ['ignore', 'ignore', 'pipe'], env });
  let driverErrors = '';
  driver.stderr.on('data', chunk => { driverErrors += chunk; });
  const exited = new Promise(resolve => driver.once('exit', resolve));
  for (let attempt = 0; !await listening(port); attempt++) {
    if (driver.exitCode !== null || attempt > 200) throw new Error('WebKitWebDriver did not start: ' + driverErrors);
    await delay(25);
  }
  const base = 'http://127.0.0.1:' + port;
  const raw = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const { value } = await response.json();
    if (!response.ok) throw new WebDriverError(value?.error, value?.message);
    return value;
  };
  const options = { binary: miniBrowser, args: ['--automation', '--proxy=' + proxy, '--ignore-host=', '--ignore-tls-errors', '--enable-page-cache=false', '--javascript-can-access-clipboard=true'] };
  const created = await raw('POST', '/session', { capabilities: { alwaysMatch: { acceptInsecureCerts: true, unhandledPromptBehavior: 'ignore', pageLoadStrategy: 'normal', 'webkitgtk:browserOptions': options } } });
  const path = '/session/' + created.sessionId;
  // No script timeout: WebKitWebDriver times scripts with the page's setTimeout, which tests may replace with fake timers.
  await raw('POST', path + '/timeouts', { script: null, pageLoad: 60000, implicit: 0 });
  let current = await raw('GET', path + '/window');
  let queue = Promise.resolve();
  let closed = false;

  /** Runs fn(command) with the session switched to window; other work waits. */
  const inWindow = (window, fn) => {
    const run = queue.then(async () => {
      if (closed) throw new Error('The browser has been closed');
      if (window && window !== current) { await raw('POST', path + '/window', { handle: window }); current = window; }
      return fn((method, suffix, body) => raw(method, path + suffix, body));
    });
    queue = run.catch(() => undefined);
    return run;
  };

  let xHelper, dragHelper;
  return {
    initialWindow: current,
    inWindow,
    /** Real X input on this session's screen (test/webkit/x-input.py). */
    xInput() { return xHelper ??= lineHelper('./x-input.py', 'python3', [], false, display.name); },
    /** A GTK drag source at the bottom right corner of this session's screen (test/webkit/x-drag.py). It needs a Python with GTK 3 bindings. */
    dragSource() { return dragHelper ??= lineHelper('./x-drag.py', process.env.PIOP_TEST_GTK_PYTHON ?? '/usr/bin/python3', ['3740', '2060'], true, display.name); },
    newWindow() { return inWindow(undefined, async command => (await command('POST', '/window/new', { type: 'window' })).handle); },
    closeWindow(window) { return inWindow(window, async command => { await command('DELETE', '/window'); current = undefined; }); },
    async close() {
      if (closed) return;
      await queue;
      closed = true;
      try { await raw('DELETE', path); } catch {}
      driver.kill();
      await Promise.race([exited, delay(3000)]);
      if (driver.exitCode === null) driver.kill('SIGKILL');
      for (const helper of await Promise.allSettled([xHelper, dragHelper])) helper.value?.close();
      display.close();
    },
  };
}
