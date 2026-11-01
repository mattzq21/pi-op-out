import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function daemonClient(t, onEvent = () => {}, { remotes = [], model } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-ui-'));
  const worker = spawn('bun', [fileURLToPath(new URL('./daemon/ui-host.ts', import.meta.url))], { env: { ...process.env, TMPDIR: directory, PIOP_TEST_UI_REMOTES: JSON.stringify(remotes), ...(model ? { PIOP_TEST_UI_MODEL: model } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  worker.stderr.on('data', data => { diagnostics += data; });
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  let socket;
  const pending = new Map();
  const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  t.after(async () => {
    socket?.close();
    worker.stdin.end();
    const timer = setTimeout(() => worker.kill('SIGKILL'), 15000);
    try {
      const result = await exited;
      if (result.code !== 0) throw new Error(`Daemon test host ended: ${JSON.stringify(result)}\n${diagnostics}`);
      await rm(directory, { recursive: true });
    } finally { clearTimeout(timer); }
  });
  const readers = [];
  createInterface({ input: worker.stdout }).on('line', line => {
    const reader = readers.shift();
    if (!reader) { diagnostics += 'Unexpected test host line: ' + line + '\n'; return; }
    try { reader.resolve(JSON.parse(line)); } catch (error) { reader.reject(error); }
  });
  worker.once('error', error => { for (const reader of readers.splice(0)) reader.reject(error); });
  exited.then(() => { for (const reader of readers.splice(0)) reader.reject(new Error('Daemon test host exited\n' + diagnostics)); });
  const readLine = (timeout = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon test host did not answer\n' + diagnostics)), timeout);
    readers.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  let endpoint = await readLine();
  const runtimes = new Set();
  let reconnecting;
  async function connect() {
    socket = new WebSocket(endpoint.url);
    const connection = socket;
    await new Promise((resolve, reject) => {
      connection.addEventListener('open', () => connection.send(JSON.stringify({ type: 'authenticate', token: endpoint.token, scope: 'client' })));
      connection.addEventListener('message', event => {
        const packet = JSON.parse(String(event.data));
        if (packet.type === 'ready') { resolve(); return; }
        if (packet.type === 'error') { reject(new Error(packet.error)); return; }
        if (packet.event) { onEvent(packet.event, packet.payload); return; }
        const request = pending.get(packet.id);
        if (!request) return;
        pending.delete(packet.id);
        if (typeof packet.error === 'string') request.reject(new Error(packet.error)); else request.resolve(packet.result);
      });
      connection.addEventListener('error', () => { const error = new Error('Daemon test connection failed'); reject(error); fail(error); });
      connection.addEventListener('close', () => { const error = new Error('Daemon test connection closed'); reject(error); fail(error); });
    });
  }
  await connect();
  let nextId = 1;
  const client = {
    async disconnect() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
    },
    async reconnect() {
      if (socket.readyState !== WebSocket.CLOSED) throw new Error('Close the existing test connection before reconnecting');
      await connect();
    },
    async invoke(command, args = {}) {
      if (reconnecting) await reconnecting;
      const id = nextId++;
      if (command === 'start_pi' && typeof args.runtimeId === 'string') runtimes.add(args.runtimeId);
      if (command === 'stop_pi') runtimes.delete(args.runtimeId);
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Daemon test connection is not open')); return; }
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, command, args }));
      });
    },
    async restart() {
      await onEvent('pi://daemon-restarting', { hostId: 'local' });
      const next = readLine(60000);
      let restarted;
      reconnecting = new Promise(resolve => { restarted = resolve; });
      try {
        worker.stdin.write('restart\n');
        await client.disconnect();
        for (const runtimeId of runtimes) await onEvent('pi://event', { runtimeId, event: { type: 'disconnected' } });
        runtimes.clear();
        endpoint = await next;
        await connect();
      } finally { reconnecting = undefined; restarted(); }
      await onEvent('pi://event', { type: 'connection_restored' });
    },
    async modelRequests() {
      const answer = readLine();
      worker.stdin.write('requests\n');
      return answer;
    },
    async listChats(sessions) {
      if (!sessions.length) return;
      const before = await client.invoke('load_session_groups', { seeds: [] });
      const listed = new Set(sessions.map(session => `${session.hostId ?? 'local'}:${session.id}`));
      const seeds = sessions.filter(session => !session.isDraft && session.messageCount > 0 && session.cwdExists !== false && session.cwd && !TEMPORARY_CHAT_CWD.test(session.cwd))
        .filter(session => !Object.hasOwn(before.assignments, `${session.hostId ?? 'local'}:${session.id}`))
        .map(session => {
          const hostId = session.hostId ?? 'local';
          const parentKey = session.forkSourceId ? `${hostId}:${session.forkSourceId}` : undefined;
          return { sessionKey: `${hostId}:${session.id}`, project: { id: `${hostId}:${session.cwd}`, name: session.project, cwd: session.cwd, hostId, hostName: session.hostName ?? 'Local' }, ...(parentKey && listed.has(parentKey) ? { parentKey } : {}) };
        }).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
      if (!seeds.length) return;
      const after = await client.invoke('load_session_groups', { seeds });
      if (JSON.stringify(after) !== JSON.stringify(before)) await onEvent('pi://groups-changed', after);
    },
  };
  return client;
}

const TEMPORARY_CHAT_CWD = /(?:^|\/)\.piop(?:-dev)?\/tmp\/[0-9a-f]{4,32}\/?$/i;
