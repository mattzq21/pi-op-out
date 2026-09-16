import { isMobile } from "../lib/platform";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-react";
import { IconButton } from "./IconButton";

interface Props {
  cwd?: string; terminals: { id: string; label: string }[]; activeId: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean;
  onAdd: () => void; onSelect: (id: string) => void; onStart: (id: string, cols: number, rows: number) => void;
  onData: (data: string) => void; onResize: (cols: number, rows: number) => void; onSnapshot: (value: string, outputEnd: number) => void; onDelete: () => void; onClose: () => void;
}

export function TerminalView({ cwd, terminals, activeId, output, outputEnd, snapshot, snapshotEnd, started, exited, onAdd, onSelect, onStart, onData, onResize, onSnapshot, onDelete, onClose }: Props) {
  const [copyError, setCopyError] = useState(false);
  const host = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | undefined>(undefined); const lastOutputEnd = useRef(0); const queuedOutputEnd = useRef(0); const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const callbacks = useRef({ onData, onResize, onStart, onSnapshot }); callbacks.current = { onData, onResize, onStart, onSnapshot };

  useEffect(() => {
    if (!cwd || !host.current) return;
    const testPalette = import.meta.env.MODE === "e2e";
    const instance = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.25, scrollback: 5000, theme: { background: "#1d1d1b", foreground: "#e5e1d8", cursor: testPalette ? "#d7b84d" : "#d46a24", selectionBackground: "#5a554b88", black: "#242320", red: "#d77865", green: "#72ad8d", yellow: testPalette ? "#d46a24" : "#c49b52", blue: "#7496b8", magenta: "#ad83ad", cyan: "#72aaa9", white: "#e5e1d8" } });
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
    let restored = !snapshot;
    if (snapshot) { queuedOutputEnd.current = snapshotEnd ?? 0; instance.write(snapshot, () => { if (terminal.current !== instance) return; lastOutputEnd.current = snapshotEnd ?? 0; restored = true; }); }
    if (!started) callbacks.current.onStart(activeId, instance.cols, instance.rows); else callbacks.current.onResize(instance.cols, instance.rows);
    instance.focus();
    const data = instance.onData((value) => callbacks.current.onData(value)); const resize = instance.onResize(({ cols, rows }) => callbacks.current.onResize(cols, rows));
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fitAndResize); observer?.observe(host.current); window.addEventListener("resize", fitAndResize);
    return () => { callbacks.current.onSnapshot(restored ? serializer.serialize() : snapshot || "", restored ? lastOutputEnd.current : snapshotEnd ?? 0); observer?.disconnect(); window.removeEventListener("resize", fitAndResize); data.dispose(); resize.dispose(); instance.dispose(); terminal.current = undefined; lastOutputEnd.current = 0; queuedOutputEnd.current = 0; };
  }, [activeId, cwd]);

  useEffect(() => {
    const instance = terminal.current; if (!instance) return;
    const outputStart = outputEnd - output.length;
    const parsed = () => { if (terminal.current === instance) lastOutputEnd.current = outputEnd; };
    if (queuedOutputEnd.current >= outputStart && queuedOutputEnd.current <= outputEnd) instance.write(output.slice(queuedOutputEnd.current - outputStart), parsed); else { instance.reset(); instance.write(output, parsed); }
    queuedOutputEnd.current = outputEnd;
  }, [output, outputEnd]);
  useEffect(() => { tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activeId, terminals.length]);

  const canAdd = terminals.length < 8;
  return <section className="terminal-shell" aria-label="Session terminal"><header><div className="terminal-tabs">{terminals.map((item) => <button ref={(element) => { if (element) tabRefs.current.set(item.id, element); else tabRefs.current.delete(item.id); }} key={item.id} className={`terminal-tab ${item.id === activeId ? "active" : ""}`} aria-pressed={item.id === activeId} onClick={() => onSelect(item.id)}><TerminalSquare size={14} /><strong>{item.label}</strong></button>)}<IconButton label={canAdd ? "Add terminal" : "Terminal limit reached"} disabled={!canAdd} onClick={onAdd}><Plus size={16} /></IconButton></div><div>{copyError && <span className="copy-feedback" role="status">Could not copy terminal selection</span>}{exited && <><span className="terminal-exited">exited</span><IconButton label="Restart terminal" onClick={() => onStart(activeId, terminal.current?.cols ?? 80, terminal.current?.rows ?? 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" onClick={onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={onClose}><X size={16} /></IconButton></div></header>
    {isMobile && cwd && <div className="mobile-terminal-keys">{[["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["Ctrl+D", "\u0004"], ["↑", "\u001b[A"], ["↓", "\u001b[B"], ["←", "\u001b[D"], ["→", "\u001b[C"]].map(([label, data]) => <button key={label} disabled={!started || exited} onPointerDown={(event) => event.preventDefault()} onClick={() => { onData(data); terminal.current?.focus(); }}>{label}</button>)}</div>}
    {cwd ? <div className="terminal-host" ref={host} onMouseDown={() => terminal.current?.focus()} /> : <div className="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
