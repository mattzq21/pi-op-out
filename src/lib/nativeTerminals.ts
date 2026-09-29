import { nativeCall, type NativeCall } from "./nativeCall";

class NativeTerminals {
  private writes = new Map<string, Promise<void>>();
  private starts = new Map<string, Promise<void>>();

  constructor(private call: NativeCall) {}

  start(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId: string) {
    const pending = this.call<void>("start_terminal", { terminalId, sessionKey, cwd, cols, rows, hostId });
    this.starts.set(terminalId, pending);
    const clear = () => { if (this.starts.get(terminalId) === pending) this.starts.delete(terminalId); };
    void pending.then(clear, clear);
    return pending;
  }

  write(terminalId: string, data: string) {
    const starting = this.starts.get(terminalId);
    const next = (this.writes.get(terminalId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => starting).then(() => this.call<void>("write_terminal", { terminalId, data }));
    this.writes.set(terminalId, next);
    const clear = () => { if (this.writes.get(terminalId) === next) this.writes.delete(terminalId); };
    void next.then(clear, clear);
    return next;
  }

  async resize(terminalId: string, cols: number, rows: number) {
    await this.starts.get(terminalId);
    return this.call<void>("resize_terminal", { terminalId, cols, rows });
  }

  async reassign(terminalId: string, sessionKey: string) {
    await this.starts.get(terminalId);
    return this.call<void>("reassign_terminal", { terminalId, sessionKey });
  }

  async close(terminalId: string) {
    await this.starts.get(terminalId)?.catch(() => undefined);
    await this.writes.get(terminalId)?.catch(() => undefined);
    this.writes.delete(terminalId);
    return this.call<void>("close_terminal", { terminalId });
  }
}

export const nativeTerminals = new NativeTerminals(nativeCall);
