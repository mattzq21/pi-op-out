import { createServer as ownershipServer } from 'node:http';
import { spawn as ownershipSpawn } from 'node:child_process';
import { createHash as ownershipHash, randomUUID as ownershipUuid } from 'node:crypto';
import { mkdir as ownershipMkdir, readFile as ownershipRead, writeFile as ownershipWrite, rename as ownershipRename, readdir as ownershipList, realpath as ownershipRealpath, open as ownershipOpen } from 'node:fs/promises';
import { join as ownershipJoin, sep as ownershipSeparator } from 'node:path';
import { homedir as ownershipHome } from 'node:os';

const ownershipError = () => new Error('Take ownership of this conversation before changing it');
function requireOwnershipClient(client) {
  if (typeof client !== 'string' || !client) throw new Error('Conversation client is missing');
}
async function optionalOwnershipPath(path) {
  try { return await ownershipRealpath(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
class ConversationOwnership {
  constructor(storage, revoke) {
    this.root = ownershipJoin(ownershipHome(), storage);
    this.directory = ownershipJoin(this.root, 'conversation-ownership');
    this.revoke = revoke;
    this.token = ownershipUuid();
    this.guards = new Map();
    this.lockChildren = new Set();
    this.server = ownershipServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${this.token}` || request.method !== 'POST') { response.writeHead(403).end(); return; }
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 8192) throw new Error('Request is too large'); }
        const { id, intent } = JSON.parse(body);
        this.key(id);
        await this.revoke(id, intent);
        response.writeHead(200).end();
      } catch { response.writeHead(409).end('Could not release conversation'); }
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.endpoint = `http://127.0.0.1:${this.server.address().port}`; this.server.unref(); resolve(); });
    });
    this.ready.catch(() => undefined);
  }

  key(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid conversation identity');
    return ownershipHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 40);
  }

  async lock(id, worker = false) {
    const directory = worker ? ownershipJoin(this.root, 'session-claims') : this.directory;
    await ownershipMkdir(directory, { recursive: true, mode: 0o700 });
    const path = ownershipJoin(directory, `${worker ? 'id-' : ''}${this.key(id)}.lock`);
    const child = ownershipSpawn('flock', ['--exclusive', '--wait', '180', '--no-fork', path, process.execPath, '-e', "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lockChildren.add(child);
    child.stdin.on('error', () => {});
    child.once('close', () => this.lockChildren.delete(child));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Conversation is busy; try taking ownership again')); }, 185000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', () => { clearTimeout(timer); reject(new Error('Could not lock conversation')); });
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      });
    } catch (error) { child.kill(); throw error; }
    return () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('close', resolve); child.stdin.end(); });
  }

  async read(id) {
    try { return JSON.parse(await ownershipRead(ownershipJoin(this.directory, `${this.key(id)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  async write(id, record) {
    const path = ownershipJoin(this.directory, `${this.key(id)}.json`);
    const temporary = `${path}.${ownershipUuid()}.tmp`;
    await ownershipWrite(temporary, JSON.stringify(record), { mode: 0o600 });
    await ownershipRename(temporary, path);
  }

  async locate(id, path, archived = false) {
    const root = await optionalOwnershipPath(ownershipJoin(this.root, archived ? 'archived' : 'sessions'));
    if (!root) return undefined;
    const candidates = path ? [path] : (await ownershipList(root)).filter((name) => name.endsWith('.jsonl')).map((name) => ownershipJoin(root, name));
    for (const candidate of candidates) {
      const saved = await this.readCandidate(id, candidate, root);
      if (saved) return saved;
    }
    return undefined;
  }

  async readCandidate(id, candidate, root) {
    const file = await optionalOwnershipPath(candidate);
    if (!file) return undefined;
    if (!file.startsWith(root + ownershipSeparator) || !file.endsWith('.jsonl')) throw new Error('Invalid conversation path');
    try {
      const handle = await ownershipOpen(file, 'r');
      let header;
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer);
        try { header = JSON.parse(buffer.subarray(0, bytesRead).toString().split('\n')[0]); } catch { return undefined; }
      } finally { await handle.close(); }
      if (header.id !== id) return undefined;
      const lines = (await ownershipRead(file, 'utf8')).trimEnd().split('\n');
      return { path: file, header, lines };
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  async releasePrevious(id, record, intent) {
    if (!record?.endpoint) return;
    if (record.endpoint === this.endpoint && record.token === this.token) { await this.revoke(id, intent); return; }
    let response;
    try { response = await fetch(record.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${record.token}` }, body: JSON.stringify({ id, intent }), signal: AbortSignal.timeout(30000) }); }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return;
      throw new Error('Could not reach the current owner; try taking ownership again');
    }
    if (!response.ok) throw new Error('The previous client could not release the conversation');
  }

  async begin(id, client, options = {}) {
    requireOwnershipClient(client);
    await this.ready;
    const unlock = await this.lock(id);
    let workerUnlock = async () => {};
    try {
      const { record, saved, denied, handoff, next } = await this.inspect(id, client, options);
      if (denied) { await unlock(); return { owned: false }; }
      if (handoff) await this.releasePrevious(id, record, options.message ? 'message' : 'transfer');
      if (!record || handoff) workerUnlock = await this.lock(id, true);
      await this.write(id, next);
      if (!options.mutation || options.message) { await workerUnlock(); workerUnlock = async () => {}; }
      return { owned: true, release: this.releaseGuard(id, next, workerUnlock, unlock), saved };
    } catch (error) { await workerUnlock(); await unlock(); throw error; }
  }

  async inspect(id, client, options) {
    const record = await this.read(id);
    const saved = await this.locate(id, options.path || record?.path, options.archived);
    this.assertAvailable(record, saved, options);
    const otherClient = Boolean(record?.client && record.client !== client);
    const returningClient = !record?.client && record?.previousClient === client && record?.endpoint === this.endpoint && record?.token === this.token;
    const handoff = Boolean(record && ((!returningClient && record.client !== client) || record.endpoint !== this.endpoint || options.mutation));
    const next = { client, endpoint: this.endpoint, token: this.token, path: saved?.path, deleted: false };
    return { record, saved, denied: otherClient && !options.take, handoff, next };
  }

  assertAvailable(record, saved, options) {
    if (record?.deleted && !options.archived || !saved && !options.create) throw new Error('This conversation has been deleted or archived');
  }

  async releaseClient(id, client, unused) {
    await this.ready;
    const unlock = await this.lock(id);
    try {
      const record = await this.read(id);
      if (!unused() || record?.client !== client || record.endpoint !== this.endpoint || record.token !== this.token || record.deleted) return;
      // Keep the worker endpoint so a new owner fences any background work,
      // but no longer require an explicit takeover from the disconnected client.
      await this.write(id, { ...record, client: null, previousClient: client });
    } finally { await unlock(); }
  }

  releaseGuard(id, record, workerUnlock, unlock) {
    return async (deleted = false) => {
      try { if (deleted) await this.write(id, { ...record, deleted: true }); }
      finally { try { await workerUnlock(); } finally { await unlock(); } }
    };
  }

  async snapshot(id, path) {
    const saved = await this.locate(id, path);
    const entries = [];
    for (const line of saved?.lines.slice(1) ?? []) { try { entries.push(JSON.parse(line)); } catch { /* A writer may be appending its final line. */ } }
    return { state: { sessionId: id, sessionFile: saved?.path, model: null, thinkingLevel: 'off', isStreaming: false, pendingMessageCount: 0, messageCount: entries.filter((entry) => entry.type === 'message').length }, history: { entries, leafId: entries.at(-1)?.id ?? null }, sequence: 0, epoch: `readonly:${id}`, liveTools: [], queue: { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] } };
  }

  shutdown() { this.server.close(); for (const child of this.lockChildren) child.kill(); }
}
