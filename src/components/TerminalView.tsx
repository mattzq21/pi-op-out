import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal } from "solid-js";
import { isMobile } from "../lib/platform";
import { createDependencyEffect, createRef } from "../lib/solid";

import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";

interface Props {
  cwd?: string; terminals: { id: string; label: string }[]; activeId: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean;
  onAdd: () => void; onSelect: (id: string) => void; onStart: (id: string, cols: number, rows: number) => void;
  onData: (data: string) => void; onResize: (cols: number, rows: number) => void; onSnapshot: (value: string, outputEnd: number) => void; onDelete: () => void; onClose: () => void;
}

export function TerminalView(componentProps: Props) {
  const [copyError, setCopyError] = createSignal(false);
  const host = createRef<HTMLDivElement>(null); const terminal = createRef<Terminal | undefined>(undefined); const lastOutputEnd = createRef(0); const queuedOutputEnd = createRef(0); const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const callbacks = createRef({ onData: componentProps.onData, onResize: componentProps.onResize, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }); createComputed(() => { callbacks.current = { onData: componentProps.onData, onResize: componentProps.onResize, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }; });

  createDependencyEffect(() => { const capturedCwd0 = componentProps.cwd; const capturedSnapshot1 = componentProps.snapshot; const capturedSnapshotEnd2 = componentProps.snapshotEnd; const capturedStarted3 = componentProps.started; const capturedActiveId4 = componentProps.activeId;
    const saveSnapshot = componentProps.onSnapshot;
    if (!capturedCwd0 || !host.current) return;
    const testPalette = import.meta.env.MODE === "e2e";
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const instance = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.25, scrollback: 5000, theme: { background: "#1d1d1b", foreground: "#e5e1d8", cursor: accent, selectionBackground: "#5a554b88", black: "#242320", red: "#d77865", green: "#72ad8d", yellow: testPalette ? "#d46a24" : "#c49b52", blue: "#7496b8", magenta: "#ad83ad", cyan: "#72aaa9", white: "#e5e1d8" } });
    const fit = new FitAddon(); const serializer = new SerializeAddon(); instance.loadAddon(fit); instance.loadAddon(serializer); instance.open(host.current); terminal.current = instance;
    setCopyError(false);
    instance.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "c") return true;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown") {
        const selection = instance.getSelection();
        setCopyError(false);
        if (selection) {
          const copy = async () => {
            try { await navigator.clipboard.writeText(selection); }
            catch { if (terminal.current === instance) setCopyError(true); }
          };
          void copy();
        }
      }
      return false;
    });
    const fitAndResize = () => { try { fit.fit(); callbacks.current.onResize(instance.cols, instance.rows); } catch { /* The panel may be between layouts. */ } };
    fit.fit();
    let restored = !capturedSnapshot1;
    if (capturedSnapshot1) { queuedOutputEnd.current = capturedSnapshotEnd2 ?? 0; instance.write((capturedSnapshot1)!, () => { if (terminal.current !== instance) return; lastOutputEnd.current = capturedSnapshotEnd2 ?? 0; restored = true; }); }
    if (!capturedStarted3) callbacks.current.onStart(capturedActiveId4, instance.cols, instance.rows); else callbacks.current.onResize(instance.cols, instance.rows);
    instance.focus();
    const data = instance.onData((value) => callbacks.current.onData(value)); const resize = instance.onResize(({ cols, rows }) => callbacks.current.onResize(cols, rows));
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fitAndResize); observer?.observe(host.current); window.addEventListener("resize", fitAndResize);
    return () => { saveSnapshot(restored ? serializer.serialize() : capturedSnapshot1 || "", restored ? lastOutputEnd.current : capturedSnapshotEnd2 ?? 0); observer?.disconnect(); window.removeEventListener("resize", fitAndResize); data.dispose(); resize.dispose(); instance.dispose(); terminal.current = undefined; lastOutputEnd.current = 0; queuedOutputEnd.current = 0; };
  }, () => [componentProps.activeId, componentProps.cwd]);

  createDependencyEffect(() => { const capturedOutputEnd0 = componentProps.outputEnd; const capturedOutput1 = componentProps.output;
    const instance = terminal.current; if (!instance) return;
    const outputStart = capturedOutputEnd0 - capturedOutput1.length;
    const parsed = () => { if (terminal.current === instance) lastOutputEnd.current = capturedOutputEnd0; };
    if (queuedOutputEnd.current >= outputStart && queuedOutputEnd.current <= capturedOutputEnd0) instance.write(capturedOutput1.slice(queuedOutputEnd.current - outputStart), parsed); else { instance.reset(); instance.write(capturedOutput1, parsed); }
    queuedOutputEnd.current = capturedOutputEnd0;
  }, () => [componentProps.output, componentProps.outputEnd]);
  createDependencyEffect(() => {
    const capturedActiveId0 = componentProps.activeId;
 tabRefs.current.get(capturedActiveId0)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, () => [componentProps.activeId, componentProps.terminals.length]);

  const canAdd = createMemo(() => (componentProps.terminals.length < 8));
  return <section class="terminal-shell" aria-label="Session terminal"><header><div class="terminal-tabs">{<Key each={componentProps.terminals} by={(item) => item.id}>{(item, index) => <button ref={(element) => { if (element) tabRefs.current.set(item().id, element); else tabRefs.current.delete(item().id); }}  class={`terminal-tab ${item().id === componentProps.activeId ? "active" : ""}`} aria-pressed={item().id === componentProps.activeId} onClick={() => componentProps.onSelect(item().id)}><TerminalSquare size={14} /><strong>{item().label}</strong></button>}</Key>}<IconButton label={canAdd() ? "Add terminal" : "Terminal limit reached"} disabled={!canAdd()} onClick={componentProps.onAdd}><Plus size={16} /></IconButton></div><div>{copyError() && <span class="copy-feedback" role="status">Could not copy terminal selection</span>}{componentProps.exited && <><span class="terminal-exited">exited</span><IconButton label="Restart terminal" onClick={() => componentProps.onStart(componentProps.activeId, terminal.current?.cols ?? 80, terminal.current?.rows ?? 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" onClick={componentProps.onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={componentProps.onClose}><X size={16} /></IconButton></div></header>
    {isMobile && componentProps.cwd && <div class="mobile-terminal-keys">{<Key each={[["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["Ctrl+D", "\u0004"], ["↑", "\u001b[A"], ["↓", "\u001b[B"], ["←", "\u001b[D"], ["→", "\u001b[C"]]} by={([label, data]) => label}>{(entry, index) => <button  disabled={!componentProps.started || componentProps.exited} onPointerDown={(event) => event.preventDefault()} onClick={() => { componentProps.onData(entry()[1]); terminal.current?.focus(); }}>{entry()[0]}</button>}</Key>}</div>}
    {componentProps.cwd ? <div class="terminal-host" ref={element => { host.current = element; }} onMouseDown={() => terminal.current?.focus()} /> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
