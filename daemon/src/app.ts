import { DaemonClients } from './daemon_clients';
import * as daemonRestart from './daemon_restart';
import { PiRuntime } from './pi_runtime';
import { interruptTerminals, TerminalRuntime } from './terminals';
import { SessionIndexRuntime } from './session_index';
import { BrokerRuntime } from './broker';
import { PeerRuntime } from './peers';

type Listener = (payload: any) => void;

/** Holds all daemon state and sends named events to listeners. */
export class App {
  clients = new DaemonClients(() => this.emit('pi://daemon-restarting', { hostId: 'local' }), () => interruptTerminals(this.terminals));
  restart = new daemonRestart.Runtime();
  pi = new PiRuntime();
  terminals = new TerminalRuntime();
  sessionIndex = new SessionIndexRuntime();
  broker = new BrokerRuntime();
  peers = new PeerRuntime();
  readonly logStatuses = new Map<string, string | null>();
  private listeners = new Map<string, Listener[]>();

  setLogStatus(hostId: string, failure: string | null): void {
    if (this.logStatuses.has(hostId) && this.logStatuses.get(hostId) === failure) return;
    this.logStatuses.set(hostId, failure);
    this.emit('pi://daemon-log-status', { hostId, failure, ...(hostId !== 'local' ? { _peer: true } : {}) });
  }

  removeLogStatus(hostId: string): void {
    if (!this.logStatuses.delete(hostId)) return;
    this.emit('pi://daemon-log-status', { hostId, failure: null, _peer: true });
  }

  emit(name: string, payload?: unknown): void {
    const listeners = this.listeners.get(name);
    if (!listeners || listeners.length === 0) return;
    const body = JSON.stringify(payload === undefined ? null : payload);
    for (const listener of [...listeners]) {
      try { listener(JSON.parse(body)); } catch (error) { process.stderr.write('Event listener failed: ' + String(error) + '\n'); }
    }
  }

  listenAny(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
}
