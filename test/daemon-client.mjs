import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function daemonClient(t, onEvent = () => {}, { remotes = [] } = {}) {
  const worker = spawn('bun', [fileURLToPath(new URL('./daemon/ui-host.ts', import.meta.url))], { env: { ...process.env, PIOP_TEST_UI_REMOTES: JSON.stringify(remotes) }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    } finally { clearTimeout(timer); }
  });
  const endpoint = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout });
    const timer = setTimeout(() => reject(new Error('Daemon test host did not start\n' + diagnostics)), 20000);
    worker.once('error', reject);
    exited.then(() => reject(new Error('Daemon test host exited before ready\n' + diagnostics)));
    lines.once('line', line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
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
  return {
    async disconnect() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
    },
    async reconnect() {
      if (socket.readyState !== WebSocket.CLOSED) throw new Error('Close the existing test connection before reconnecting');
      await connect();
    },
    invoke(command, args = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Daemon test connection is not open')); return; }
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, command, args }));
      });
    },
  };
}
