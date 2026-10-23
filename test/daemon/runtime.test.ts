import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonExecutable, fakeProgram, remoteMachine, startDaemon, temporaryDirectory, useRemotes, type Client, type RemoteMachine, type TestDaemon } from './harness';

let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startDaemon();
  // Interactive bash reads ~/.bashrc; a test controls its terminal with a script in the terminal directory.
  writeFileSync(join(daemon.home, '.bashrc'), '[ -f ./.terminal-script ] && exec sh ./.terminal-script\n');
}, 60_000);
afterAll(() => daemon?.stop());

let counter = 0;
/** A directory whose terminal runs the given shell script instead of an interactive prompt. */
function terminalDirectory(script: string, name = 'terminal'): string {
  const directory = join(temporaryDirectory('piop-terminal-'), name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.terminal-script'), script);
  return directory;
}

const terminalEvents = (client: Client, terminalId: string, from = 0) =>
  client.events.slice(from).filter(event => event.event === 'pi://event' && event.payload?.terminalId === terminalId).map(event => event.payload);
const output = (client: Client, terminalId: string, from = 0) =>
  terminalEvents(client, terminalId, from).filter(packet => packet.type === 'terminal_output').map(packet => packet.data).join('');
const exited = (client: Client, terminalId: string) =>
  client.waitEvent('pi://event', packet => packet.type === 'terminal_exit' && packet.terminalId === terminalId, 10_000);
const start = (client: Client, cwd: string, options: Record<string, unknown> = {}) => {
  const terminalId = 'terminal-' + ++counter;
  return client.invoke('start_terminal', { terminalId, sessionKey: 'local:session-' + counter, cwd, cols: 80, rows: 24, ...options }).then(() => terminalId);
};

test('a terminal streams its shell output after the size report and ends with one exit event', async () => {
  const cwd = terminalDirectory("printf 'hello \\316\\273'; exit 0\n");
  const from = daemon.events.length;
  const id = await start(daemon, cwd, { cols: 0, rows: 0 });
  await exited(daemon, id);
  expect(output(daemon, id, from)).toBe('\u001b[8;1;1thello λ');
  const packets = terminalEvents(daemon, id, from);
  expect(packets.at(-1)).toMatchObject({ type: 'terminal_exit', terminalId: id, sessionId: 'session-' + counter, hostId: 'local' });
  expect(packets.filter(packet => packet.type === 'terminal_exit')).toHaveLength(1);
  expect(await daemon.failure('write_terminal', { terminalId: id, data: 'x' })).toBe('Terminal is not running');
});

const waitOutput = (client: Client, terminalId: string, text: string, from = 0) =>
  client.waitEvent('pi://event', () => output(client, terminalId, from).includes(text), 10_000);

test('input and a resize reach the shell, and the size starts at least 1 by 1', async () => {
  const cwd = terminalDirectory("stty -echo; printf 'size:%s|' \"$(stty size)\"; printf READY; IFS= read -r line; printf 'received:%s\\n' \"$line\"; stty size\n");
  const from = daemon.events.length;
  const id = await start(daemon, cwd, { cols: 0, rows: 0 });
  await waitOutput(daemon, id, 'READY', from);
  expect(output(daemon, id, from)).toContain('size:1 1|');
  await daemon.invoke('resize_terminal', { terminalId: id, cols: 100, rows: 40 });
  await daemon.invoke('write_terminal', { terminalId: id, data: 'hello λ\n' });
  await exited(daemon, id);
  expect(output(daemon, id, from)).toMatch(/received:hello λ\r?\n40 100/);
});

test('UTF-8 split across output reads stays whole and invalid or unfinished bytes become replacement characters', async () => {
  // Each part ends inside a character and the shell waits for a line before the next part, so each part is a separate read.
  const cwd = terminalDirectory([
    'stty -echo',
    "printf 'A\\360'; read x",
    "printf '\\237\\230\\200B\\342'; read x",
    "printf '\\202\\254C'; read x",
    "printf 'ok\\377\\376after'; read x",
    "printf '\\342\\202'",
  ].join('\n') + '\n');
  const from = daemon.events.length;
  const id = await start(daemon, cwd);
  for (const visible of ['A', 'A😀B', 'A😀B€C', 'A😀B€Cok\uFFFD\uFFFDafter']) {
    await waitOutput(daemon, id, visible, from);
    await daemon.invoke('write_terminal', { terminalId: id, data: '\n' });
  }
  await exited(daemon, id);
  expect(output(daemon, id, from)).toBe('\u001b[8;24;80tA😀B€Cok\uFFFD\uFFFDafter\uFFFD');
});

test('large output across many chunks arrives complete', async () => {
  const cwd = terminalDirectory("i=0; while [ $i -lt 30000 ]; do printf 'line \\316\\273 \\360\\237\\230\\200\\n'; i=$((i+1)); done\n");
  const from = daemon.events.length;
  const id = await start(daemon, cwd);
  await exited(daemon, id);
  expect(terminalEvents(daemon, id, from).filter(packet => packet.type === 'terminal_output').length).toBeGreaterThan(2);
  // The terminal turns each newline into a carriage return and newline.
  expect(output(daemon, id, from)).toBe('\u001b[8;24;80t' + 'line λ 😀\r\n'.repeat(30000));
});

/** The shell writes its PID before READY, so read it once READY has arrived. */
const pidOf = (directory: string) => Number(readFileSync(join(directory, 'pid'), 'utf8'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SLEEPER = "echo $$ > pid; printf READY; exec sleep 60\n";

test('closing a terminal stops its shell without an exit event and leaves other terminals running', async () => {
  const stopDirectory = terminalDirectory(SLEEPER);
  const otherDirectory = terminalDirectory("stty -echo; printf READY; IFS= read -r line; printf 'got:%s' \"$line\"; exec sleep 60\n");
  const from = daemon.events.length;
  const stopped = await start(daemon, stopDirectory);
  const other = await start(daemon, otherDirectory);
  await waitOutput(daemon, stopped, 'READY', from);
  await waitOutput(daemon, other, 'READY', from);
  const pid = pidOf(stopDirectory);
  await daemon.invoke('close_terminal', { terminalId: stopped });
  expect(alive(pid)).toBe(false);
  await daemon.invoke('close_terminal', { terminalId: stopped });
  await daemon.invoke('close_terminal', { terminalId: 'missing' });
  expect(await daemon.failure('write_terminal', { terminalId: stopped, data: 'x' })).toBe('Terminal is not running');
  expect(await daemon.failure('resize_terminal', { terminalId: 'missing', cols: 80, rows: 24 })).toBe('Terminal is not running');
  await daemon.invoke('write_terminal', { terminalId: other, data: 'still available\n' });
  await waitOutput(daemon, other, 'got:still available', from);
  await Bun.sleep(300);
  expect(terminalEvents(daemon, stopped, from).map(packet => packet.type)).toEqual(['terminal_output', 'terminal_output']);
  await daemon.invoke('close_terminal', { terminalId: other });
});

test('another connection cannot use a terminal, and a closed connection stops its own terminals', async () => {
  const owner = await daemon.connect();
  const directory = terminalDirectory(SLEEPER);
  const id = await start(owner, directory);
  await waitOutput(owner, id, 'READY');
  const pid = pidOf(directory);
  for (const [command, args] of [['write_terminal', { data: 'x' }], ['resize_terminal', { cols: 90, rows: 30 }], ['close_terminal', {}], ['start_terminal', { sessionKey: 'local:other', cwd: directory, cols: 80, rows: 24 }]] as const) {
    expect(await daemon.failure(command, { terminalId: id, ...args }), command).toBe('Terminal belongs to another connection');
  }
  expect(alive(pid)).toBe(true);
  owner.close();
  for (let tries = 0; alive(pid) && tries < 200; tries++) await Bun.sleep(25);
  expect(alive(pid)).toBe(false);
});

test('starting a running terminal again keeps the one shell', async () => {
  const directory = terminalDirectory(SLEEPER);
  const from = daemon.events.length;
  const id = await start(daemon, directory);
  await waitOutput(daemon, id, 'READY', from);
  const pid = pidOf(directory);
  await daemon.invoke('start_terminal', { terminalId: id, sessionKey: 'local:session-' + counter, cwd: directory, cols: 80, rows: 24 });
  await Bun.sleep(300);
  expect(output(daemon, id, from)).toBe('\u001b[8;24;80tREADY');
  expect(alive(pid)).toBe(true);
  await daemon.invoke('close_terminal', { terminalId: id });
});

test('a session runs at most 8 terminals and a failed launch registers nothing', async () => {
  const sessionKey = 'local:limited-session';
  const directory = terminalDirectory(SLEEPER);
  const ids = Array.from({ length: 8 }, (_, index) => 'limited-' + index);
  for (const terminalId of ids) await daemon.invoke('start_terminal', { terminalId, sessionKey, cwd: directory, cols: 80, rows: 24 });
  expect(await daemon.failure('start_terminal', { terminalId: 'limited-extra', sessionKey, cwd: directory, cols: 80, rows: 24 })).toBe('At most 8 terminals may run for one conversation');
  const missing = join(directory, 'missing');
  expect(await daemon.failure('start_terminal', { terminalId: 'bad-cwd', sessionKey: 'local:other', cwd: missing, cols: 80, rows: 24 })).toBe('Terminal working directory does not exist: ' + missing);
  for (const [cols, rows] of [[-1, 24], [80, 65536], [1.5, 24]]) {
    expect(await daemon.failure('start_terminal', { terminalId: 'bad-size', sessionKey: 'local:other', cwd: directory, cols, rows })).toBe('Invalid terminal size');
  }
  for (const terminalId of ['limited-extra', 'bad-cwd', 'bad-size']) expect(await daemon.failure('write_terminal', { terminalId, data: 'x' })).toBe('Terminal is not running');
  await daemon.invoke('close_terminal', { terminalId: ids[0] });
  await daemon.invoke('start_terminal', { terminalId: 'limited-extra', sessionKey, cwd: directory, cols: 80, rows: 24 });
  for (const terminalId of [...ids.slice(1), 'limited-extra']) await daemon.invoke('close_terminal', { terminalId });
});

test('terminal input over 1 MiB is rejected, and unread input past the queue limit reports busy', async () => {
  const directory = terminalDirectory("stty -echo -icanon; printf READY; exec sleep 60\n");
  const from = daemon.events.length;
  const id = await start(daemon, directory);
  await waitOutput(daemon, id, 'READY', from);
  const block = '🌍'.repeat(256 * 1024);
  expect(await daemon.failure('write_terminal', { terminalId: id, data: block + 'x' })).toBe('Terminal input exceeds 1 MiB; paste a smaller block');
  let busy = '';
  for (let index = 0; index < 8 && !busy; index++) {
    busy = await daemon.invoke('write_terminal', { terminalId: id, data: block }).then(() => '', (error: Error) => error.message);
  }
  expect(busy).toBe('Terminal input is busy; wait or close the terminal');
  await daemon.invoke('close_terminal', { terminalId: id });
});

test('resizing rejects invalid sizes and raises 0 to 1', async () => {
  const directory = terminalDirectory("stty -echo; printf READY; while IFS= read -r line; do printf 'size:%s|' \"$(stty size)\"; done\n");
  const from = daemon.events.length;
  const id = await start(daemon, directory);
  await waitOutput(daemon, id, 'READY', from);
  for (const [cols, rows] of [[-1, 24], [80, 70000], [10.5, 3]]) {
    expect(await daemon.failure('resize_terminal', { terminalId: id, cols, rows })).toBe('Invalid terminal size');
  }
  await daemon.invoke('resize_terminal', { terminalId: id, cols: 0, rows: 0 });
  await daemon.invoke('write_terminal', { terminalId: id, data: '\n' });
  await waitOutput(daemon, id, 'size:1 1|', from);
  await daemon.invoke('resize_terminal', { terminalId: id, cols: 132, rows: 43 });
  await daemon.invoke('write_terminal', { terminalId: id, data: '\n' });
  await waitOutput(daemon, id, 'size:43 132|', from);
  await daemon.invoke('close_terminal', { terminalId: id });
});

test('input messages reach the shell in order with control bytes intact', async () => {
  const directory = terminalDirectory("stty raw -echo; printf READY; dd bs=1 count=15 2>/dev/null | od -An -tx1; printf DONE\n");
  const from = daemon.events.length;
  const id = await start(daemon, directory);
  await waitOutput(daemon, id, 'READY', from);
  for (const data of ['hello λ', '\n', '', 'exit\r', '\u0003']) await daemon.invoke('write_terminal', { terminalId: id, data });
  await waitOutput(daemon, id, 'DONE', from);
  const hex = output(daemon, id, from).split('READY')[1]!.split('DONE')[0]!.replace(/\s+/g, '');
  expect(hex).toBe('68656c6c6f20cebb0a657869740d03');
  await daemon.invoke('close_terminal', { terminalId: id });
});

/** A fake Codex app server: it answers each request with the saved body for its method and the request's id. */
const FAKE_CODEX = `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) body=initialize;;
    *'"method":"account/rateLimits/read"'*) body=rate-limits;;
    *) continue;;
  esac
  printf '{"id":%s,%s}\\n' "$id" "$(cat "$HOME/.fake-codex/$body")"
done
`;

function codexAnswers(rateLimits: string, initialize = '"result":{}'): void {
  const directory = join(daemon.home, '.fake-codex');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'initialize'), initialize);
  writeFileSync(join(directory, 'rate-limits'), rateLimits);
}

test('Codex usage reports the most used window of the codex limit and clamps the remaining percent', async () => {
  fakeProgram(daemon.bin, 'codex', FAKE_CODEX);
  codexAnswers('"result":' + JSON.stringify({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, resetsAt: 100 }, secondary: { usedPercent: 80.4, resetsAt: 200 } } }, rateLimits: { primary: { usedPercent: 99 } } }));
  expect(await daemon.invoke('codex_usage')).toEqual({ remainingPercent: 20, resetAt: 200 });
  for (const [used, remaining] of [[-2, 100], [150, 0], [0, 100]]) {
    codexAnswers('"result":' + JSON.stringify({ rateLimits: { primary: { usedPercent: used } } }));
    expect(await daemon.invoke('codex_usage'), String(used)).toEqual({ remainingPercent: remaining });
  }
  for (const result of [null, {}, { rateLimits: {} }, { rateLimits: { primary: { usedPercent: 'bad' } } }]) {
    codexAnswers('"result":' + JSON.stringify(result));
    expect(await daemon.failure('codex_usage'), JSON.stringify(result)).toBe('Codex usage is unavailable');
  }
});

const remoteSetting = (host: Record<string, unknown> = {}) => ({ enabled: false, id: 'remote', name: 'Server', target: 'user@example.com', piPath: 'pi', ...host });
async function saveHosts(hosts: any[]): Promise<string> {
  const settings = await daemon.invoke('load_app_settings');
  settings.hosts = hosts;
  return daemon.invoke('save_app_settings', { settings }).then(() => '', (error: Error) => error.message);
}

test('machines accept plain SSH targets and executable paths and reject shell syntax', async () => {
  for (const target of ['example.com', 'user@server-1', 'user@[2001:db8::1]', 'local_alias']) {
    for (const piPath of ['pi', '~/bin/pi', '/opt/pi/bin/pi', './node_modules/.bin/pi']) {
      expect(await saveHosts([remoteSetting({ target, piPath })]), target + ' ' + piPath).toBe('');
    }
  }
  for (const target of ['', 'host name', 'host;id', '$(id)', 'host\nother', "host'", 'hébergeur']) {
    expect(await saveHosts([remoteSetting({ target })]), target).toContain('SSH target');
  }
  for (const piPath of ['', 'pi --flag', '/path with spaces/pi', 'pi;id', '$(id)', 'pi\nother', "pi'"]) {
    expect(await saveHosts([remoteSetting({ piPath })]), piPath).toContain('Pi executable');
  }
  expect(await saveHosts([remoteSetting()])).toBe('');
  expect(await daemon.failure('home_directory', { hostId: 'remote' })).toBe('Host Server is disabled');
  expect(await daemon.failure('home_directory', { hostId: 'missing' })).toBe('Unknown host: missing');
  expect(await saveHosts([])).toBe('');
});

test('a remote machine starts piopd from a home, absolute or relative executable path', async () => {
  const executable = await daemonExecutable();
  const machines: RemoteMachine[] = [];
  try {
    const forms: Array<[string, (home: string) => [string, string]]> = [
      ['home', home => [join(home, 'bin/piopd'), '~/bin/pi']],
      ['absolute', home => [join(home, 'opt/pi-tools/piopd'), join(home, 'opt/pi-tools/pi')]],
      ['relative', home => [join(home, 'tools/piopd'), './tools/pi']],
    ];
    const settings = [];
    for (const [id, place] of forms) {
      const machine = await remoteMachine(daemon, id);
      machines.push(machine);
      const [link, piPath] = place(machine.home);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(executable, link);
      settings.push({ id, name: id, target: id, piPath });
    }
    // useRemotes fails unless each machine answers through its configured executable.
    await useRemotes(daemon, settings);
    for (const machine of machines) expect(await daemon.invoke('home_directory', { hostId: machine.id })).toBe(realpathSync(machine.home));
  } finally {
    await useRemotes(daemon, []);
    for (const machine of machines) await machine.stop();
  }
});

test('a remote terminal opens a directory whose name contains quotes, shell syntax and UTF-8', async () => {
  const server = await remoteMachine(daemon, 'server', 'Server');
  try {
    await useRemotes(daemon, [server]);
    writeFileSync(join(server.home, '.bashrc'), '[ -f ./.terminal-script ] && exec sh ./.terminal-script\n');
    const cwd = join(server.home, "it's $(touch injected) \`touch injected\`; λ");
    mkdirSync(cwd);
    writeFileSync(join(cwd, '.terminal-script'), "printf 'cwd:%s|' \"$PWD\"\n");
    const from = daemon.events.length;
    const terminalId = 'remote-terminal';
    await daemon.invoke('start_terminal', { terminalId, sessionKey: 'server:remote-session', cwd, cols: 80, rows: 24, hostId: 'server' });
    await exited(daemon, terminalId);
    expect(output(daemon, terminalId, from)).toBe('\u001b[8;24;80tcwd:' + cwd + '|');
    expect(readdirSync(server.home)).not.toContain('injected');
    expect(readdirSync(cwd)).toEqual(['.terminal-script']);
  } finally {
    await useRemotes(daemon, []);
    await server.stop();
  }
});

test('a remote machine with the plain pi executable starts piopd found on its PATH', async () => {
  const sshPath = join(daemon.bin, 'ssh');
  const harnessSsh = readFileSync(sshPath, 'utf8');
  const server = await remoteMachine(daemon, 'plain', 'Plain');
  try {
    // The remote login sees only its own ~/.local/bin and system programs, so no piopd of this user can start.
    const bin = join(server.home, '.local/bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(await daemonExecutable(), join(bin, 'piopd'));
    symlinkSync(process.execPath, join(bin, 'bun'));
    // The daemon validates extensions with the Pi package and Node.js that this machine has installed.
    for (const program of ['pi', 'node']) {
      const path = Bun.which(program);
      if (!path) throw new Error(program + ' is needed on PATH for the remote machine fixture');
      symlinkSync(path, join(bin, program));
    }
    unlinkSync(join(server.home, '.bun/bin/piopd'));
    const restricted = harnessSsh.replace('HOME="$remote"', 'HOME="$remote" PATH="$remote/.local/bin:/usr/bin:/bin"');
    expect(restricted).not.toBe(harnessSsh);
    fakeProgram(daemon.bin, 'ssh', restricted);
    await useRemotes(daemon, [{ id: 'plain', name: 'Plain', target: 'plain', piPath: 'pi' }]);
    expect(await daemon.invoke('home_directory', { hostId: 'plain' })).toBe(realpathSync(server.home));
  } finally {
    await useRemotes(daemon, []);
    fakeProgram(daemon.bin, 'ssh', harnessSsh);
    await server.stop();
  }
});

/** The number of running processes whose command line contains marker. */
const running = (marker: string) => readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').includes(marker); } catch { return false; }
}).length;

test('closing a terminal also stops the programs started from it, even ones that left its process group', async () => {
  const background = '6300.' + ++counter, detached = '6400.' + counter;
  const directory = terminalDirectory(`sleep ${background} & setsid sleep ${detached} > /dev/null 2>&1 & printf READY; exec sleep 600\n`);
  const from = daemon.events.length;
  const terminal = await start(daemon, directory);
  await waitOutput(daemon, terminal, 'READY', from);
  for (let tries = 0; tries < 50 && (!running('sleep ' + background) || !running('sleep ' + detached)); tries++) await Bun.sleep(50);
  expect([running('sleep ' + background), running('sleep ' + detached)]).toEqual([1, 1]);
  await daemon.invoke('close_terminal', { terminalId: terminal });
  for (let tries = 0; tries < 60 && (running('sleep ' + background) || running('sleep ' + detached)); tries++) await Bun.sleep(50);
  expect([running('sleep ' + background), running('sleep ' + detached)]).toEqual([0, 0]);
});
