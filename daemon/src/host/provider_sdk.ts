import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import * as DaemonRestart from '../daemon_restart';
import { fastCapabilities, providerSdk, sdkStorageBundle } from '../resources';
import { Mutex } from '../util/sync';

const SOURCE_ARGUMENT_BYTES = 64 * 1024;
const SOURCE_LOADER = "await import('data:text/javascript;base64,' + process.argv.splice(2).join(''));";

/** Receives event packets that the provider SDK process sends without a request. */
export interface Events { event(packet: any): void }

const quiet: Events = { event() {} };

function sourceArguments(encoded: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < encoded.length; start += SOURCE_ARGUMENT_BYTES) parts.push(encoded.slice(start, start + SOURCE_ARGUMENT_BYTES));
  return parts;
}

interface Pending { resolve(value: any): void; reject(error: Error): void }

class Connection {
  pending = new Map<string, Pending>();
  closed = false;
  constructor(readonly child: ChildProcess) {}
  stop(error = new Error('Pi provider SDK stopped')): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, reply] of this.pending) reply.reject(error);
    this.pending.clear();
    try {
      if (!this.child.kill('SIGKILL') && this.child.exitCode === null && this.child.signalCode === null) console.error('Could not stop Pi provider SDK process');
    } catch (failure) { console.error('Could not stop Pi provider SDK:', failure); }
  }
}

export async function resolveProviderAuth(executable: string, providerId: string): Promise<any> {
  const sdk = new Sdk(executable, quiet);
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

/** Runs the bundled provider SDK script in a Node process and sends it JSON line requests. */
export class Sdk {
  private connection: Connection | undefined;
  private gate = new Mutex();
  private stopped = false;

  constructor(private executable: string, private events: Events, private plugin?: string) {}

  static plugin(executable: string, events: Events, source: string): Sdk { return new Sdk(executable, events, source); }

  private spawnProcess(encoded: string): ChildProcess {
    const env = { ...process.env, PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY, PI_CODING_AGENT_DIR: join(homeDir(), STORAGE_DIRECTORY) };
    const child = spawn('node', ['--input-type=module', '-e', SOURCE_LOADER, '--', this.executable, ...sourceArguments(encoded)], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    return child;
  }

  private async connect(): Promise<Connection> {
    return this.gate.run(async () => {
      if (this.stopped) throw new Error('Provider SDK stopped');
      if (this.connection && !this.connection.closed) return this.connection;
      const storage = "const { installRuntimeStorage, storedModelText, saveStoredModelProvider } = await import('data:text/javascript;base64," + Buffer.from(sdkStorageBundle).toString('base64') + "');";
      const source = [storage, fastCapabilities, this.plugin ?? 'const bundledPlugin = null;', providerSdk].join('\n');
      const child = this.spawnProcess(Buffer.from(source).toString('base64'));
      const connection = new Connection(child);
      const started = await new Promise<Error | undefined>(resolve => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', error => resolve(error));
      });
      if (started) throw new Error('Could not start Pi provider SDK: ' + started.message);
      child.stdin!.on('error', () => {});
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on('line', line => {
        let packet: any;
        try { packet = JSON.parse(line); } catch { return; }
        if (typeof packet?.event === 'string') { try { this.events.event(packet); } catch {} return; }
        if (typeof packet?.id !== 'string') return;
        const reply = connection.pending.get(packet.id);
        if (!reply) return;
        connection.pending.delete(packet.id);
        if (typeof packet.error === 'string') reply.reject(new Error(packet.error));
        else reply.resolve(packet.data === undefined ? null : packet.data);
      });
      let lineClosed = false;
      let exited = false;
      const finish = () => {
        if (!lineClosed || !exited || connection.closed) return;
        connection.closed = true;
        for (const [, reply] of connection.pending) reply.reject(new Error('Pi provider SDK disconnected'));
        connection.pending.clear();
      };
      lines.on('close', () => { lineClosed = true; finish(); });
      child.on('exit', () => { exited = true; finish(); });
      this.connection = connection;
      return connection;
    });
  }

  async request(packet: any): Promise<any> {
    const connection = await this.connect();
    const id = randomUUID();
    const message = { ...packet, id };
    let timer: NodeJS.Timeout | undefined;
    try {
      if (connection.closed) throw new Error('Pi provider SDK disconnected');
      if (this.plugin !== undefined && packet?.method === 'plugin_call' && (await DaemonRestart.blocking())) throw new Error('The daemon is restarting. Reconnect before retrying.');
      if (connection.closed) throw new Error('Pi provider SDK disconnected');
      timer = setTimeout(() => connection.stop(new Error('Pi provider SDK request timed out; unresponsive worker stopped')), 630_000);
      return await new Promise<any>((resolve, reject) => {
        connection.pending.set(id, { resolve, reject });
        connection.child.stdin!.write(JSON.stringify(message) + '\n', error => { if (error) reject(error); });
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
