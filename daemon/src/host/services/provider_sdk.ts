import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { STORAGE_DIRECTORY, homeDir, nodeExecutable, pathWithNode } from '../../environment';
import { generatedExtensions } from '../../extensions';
import { readLines } from '../../util/lines.ts';
import { installedPi } from '../../pi';
import { Mutex } from '../../util/sync';
import type { Duplex } from 'node:stream';
import { PiStorage } from '../pi';

const REQUEST_TIMEOUT_MS = 630_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface Events { event(packet: any): void; stopped?(error: Error): void }

const quiet: Events = { event() {} };

interface Pending { resolve(value: any): void; reject(error: Error): void }

class Connection {
  pending = new Map<string, Pending>();
  closed = false;
  probing = false;
  constructor(readonly child: ChildProcess, private onClose: (error: Error) => void) {}

  close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, reply] of this.pending) reply.reject(error);
    this.pending.clear();
    this.onClose(error);
  }

  stop(error = new Error('Pi provider SDK stopped')): void {
    if (this.closed) return;
    this.close(error);
    try {
      if (!this.child.kill('SIGKILL') && this.child.exitCode === null && this.child.signalCode === null) console.error('Could not stop Pi provider SDK process');
    } catch (failure) { console.error('Could not stop Pi provider SDK:', failure); }
  }

  send(message: any, failed: (error: Error) => void): void {
    this.child.stdin!.write(JSON.stringify(message) + '\n', error => { if (error) failed(error); });
  }
}

export async function resolveProviderAuth(providerId: string): Promise<any> {
  const sdk = new Sdk(quiet);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sdk.request({ method: 'auth', providerId }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pi provider credential resolution timed out')), 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await sdk.shutdown();
  }
}

export class Sdk {
  private connection: Connection | undefined;
  private gate = new Mutex();
  private stopped = false;

  constructor(private events: Events) {}

  private spawnProcess(node: string, root: string): ChildProcess {
    const storage = join(homeDir(), STORAGE_DIRECTORY);
    const env = { ...process.env, PATH: pathWithNode(node), PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY, PI_CODING_AGENT_DIR: storage, PIOP_STORAGE_CHANNEL: '3' };
    const child = spawn(node, [generatedExtensions().providerSdk, root], { env, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
    // Sign-ins and model settings that the SDK saves go through its storage channel, like Pi's.
    if (child.stdio[3]) new PiStorage(storage, ['settings']).serve(child.stdio[3] as Duplex, message => console.error('Pi provider SDK: ' + message));
    return child;
  }

  private async connect(): Promise<Connection> {
    return this.gate.run(async () => {
      if (this.stopped) throw new Error('Provider SDK stopped');
      if (this.connection && !this.connection.closed) return this.connection;
      const { root } = await installedPi();
      if (this.stopped) throw new Error('Provider SDK stopped');
      const node = nodeExecutable();
      const child = this.spawnProcess(node, root);
      const connection = new Connection(child, error => {
        if (this.stopped) return;
        try { this.events.stopped?.(error); } catch (failure) { console.error('Pi provider SDK stop handler failed:', failure); }
      });
      const started = await new Promise<Error | undefined>(resolve => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', error => resolve(error));
      });
      if (started) {
        const missing = (started as NodeJS.ErrnoException).code === 'ENOENT';
        throw new Error(missing ? 'Node.js was not found at ' + node + '. Install Node.js or add it to PATH, then try again.' : 'Could not start Pi provider SDK: ' + started.message);
      }
      child.on('error', error => console.error('Pi provider SDK process error:', error));
      child.stdin!.on('error', () => {});
      let lineClosed = false;
      let exited = false;
      let exit = '';
      const finish = () => {
        if (!lineClosed || !exited) return;
        connection.close(new Error('Pi provider SDK disconnected' + exit));
      };
      readLines(child.stdout!, line => {
        let packet: any;
        try { packet = JSON.parse(line); } catch { console.error('Pi provider SDK wrote an invalid line: ' + line.slice(0, 200)); return; }
        if (typeof packet?.event === 'string') { try { this.events.event(packet); } catch (error) { console.error('Pi provider SDK event handler failed:', error); } return; }
        if (typeof packet?.id !== 'string') return;
        const reply = connection.pending.get(packet.id);
        if (!reply) return;
        connection.pending.delete(packet.id);
        if (typeof packet.error === 'string') reply.reject(new Error(packet.error));
        else reply.resolve(packet.data === undefined ? null : packet.data);
      }, () => { lineClosed = true; finish(); });
      child.on('exit', (code, signal) => { exited = true; exit = signal ? ' (signal ' + signal + ')' : ' (exit code ' + code + ')'; finish(); });
      this.connection = connection;
      return connection;
    });
  }

  private async probe(connection: Connection): Promise<void> {
    if (connection.closed || connection.probing) return;
    connection.probing = true;
    const id = randomUUID();
    const alive = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      const done = (value: boolean) => { clearTimeout(timer); resolve(value); };
      connection.pending.set(id, { resolve: () => done(true), reject: () => done(false) });
      connection.send({ method: 'ping', id }, () => done(false));
    });
    connection.pending.delete(id);
    connection.probing = false;
    if (!alive) connection.stop(new Error('Pi provider SDK stopped responding and was stopped'));
  }

  async request(packet: any): Promise<any> {
    const connection = await this.connect();
    const id = randomUUID();
    const message = { ...packet, id };
    let timer: NodeJS.Timeout | undefined;
    try {
      if (connection.closed) throw new Error('Pi provider SDK disconnected');
      return await new Promise<any>((resolve, reject) => {
        timer = setTimeout(() => {
          connection.pending.delete(id);
          reject(new Error('Pi provider SDK request timed out'));
          void this.probe(connection);
        }, REQUEST_TIMEOUT_MS);
        connection.pending.set(id, { resolve, reject });
        connection.send(message, reject);
      });
    } finally {
      clearTimeout(timer);
      connection.pending.delete(id);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.gate.run(() => {
      const connection = this.connection;
      this.connection = undefined;
      connection?.stop();
    });
  }
}
