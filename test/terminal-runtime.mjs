export const terminals = [];
export class Terminal {
  constructor(options) { this.options = options; this.cols = 100; this.rows = 30; this.writes = []; this.completions = []; this.addons = []; this.selection = ''; this.resets = 0; terminals.push(this); }
  loadAddon(addon) { this.addons.push(addon); addon.terminal = this; }
  open(host) { this.host = host; }
  attachCustomKeyEventHandler(handler) { this.key = handler; }
  getSelection() { return this.selection; }
  focus() { this.focused = (this.focused ?? 0) + 1; }
  write(value, callback) { this.writes.push(value); this.completions.push(callback); }
  flush() { for (const callback of this.completions.splice(0)) callback?.(); }
  reset() { this.resets++; }
  onData(handler) { this.data = handler; return { dispose: () => { this.dataDisposed = true; } }; }
  onResize(handler) { this.resize = handler; return { dispose: () => { this.resizeDisposed = true; } }; }
  dispose() { this.disposed = true; }
}
export class FitAddon { fit() { if (this.error) throw this.error; this.fits = (this.fits ?? 0) + 1; } }
export class SerializeAddon { serialize() { return `serialized:${this.terminal.writes.join('')}`; } }
