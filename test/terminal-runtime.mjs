export const terminals = [];

export class Terminal {
  constructor(options) { this.options = options; this.cols = 100; this.rows = 30; this.writes = []; this.completions = []; this.addons = []; this.selection = ''; this.resets = 0;
    this.modes = { mouseTrackingMode: 'none' };
    this.parser = { registerCsiHandler: (_identifier, handler) => { this.csiHandler = handler;

      return { dispose: () => { this.csiDisposed = true; } }; } };

    terminals.push(this); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  loadAddon(addon) { this.addons.push(addon); addon.terminal = this; }
  open(host) { this.host = host; }
  attachCustomKeyEventHandler(handler) { this.key = handler; }
  getSelection() { return this.selection; }
  focus() { this.focused = (this.focused ?? 0) + 1; }
  blur() { this.focused = 0; }
  write(value, callback) { this.writes.push(value); this.completions.push(callback); }
  flush() { for (const callback of this.completions.splice(0)) callback?.(); }
  reset() { this.resets++; }
  onKey(handler) { this.keyInput = handler;
    return { dispose: () => { this.keyInput = undefined; } }; }
  onData(handler) { this.data = value => { this.keyInput?.(); handler(value); };

  return { dispose: () => { this.dataDisposed = true; } }; }
  onResize(handler) { this.resizeHandler = handler;

  return { dispose: () => { this.resizeDisposed = true; } }; }
  onCursorMove(handler) { this.cursorMove = handler;

  return { dispose: () => { this.cursorDisposed = true; } }; }
  onRender(handler) { this.render = handler;

  return { dispose: () => { this.renderDisposed = true; } }; }
  onScroll(handler) { this.scroll = handler;

  return { dispose: () => { this.scrollDisposed = true; } }; }
  dispose() { this.disposed = true; }
}

export class FitAddon { fit() { if (this.error) throw this.error; } proposeDimensions() { return { cols: this.terminal.cols, rows: this.terminal.rows }; } }

export class SerializeAddon { serialize() { return `serialized:${this.terminal.writes.join('')}`; } }
