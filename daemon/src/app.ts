import { DaemonClients } from './daemon_clients';
import * as daemonRestart from './daemon_restart';
import { PiRuntime } from './pi_runtime';
import { TerminalRuntime } from './terminals';
import { SessionIndexRuntime } from './session_index';
import { BrokerRuntime } from './broker';
import { PeerRuntime } from './peers';

type Listener = (payload: any) => void;

/** Holds all daemon state and sends named events to listeners. */
export class App {
  clients = new DaemonClients();
  restart = new daemonRestart.Runtime();
  pi = new PiRuntime();
  terminals = new TerminalRuntime();
  sessionIndex = new SessionIndexRuntime();
  broker = new BrokerRuntime();
  peers = new PeerRuntime();
  private listeners = new Map<string, Listener[]>();

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
