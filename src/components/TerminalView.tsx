import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, TerminalSquare, Trash2, X } from "lucide-react";
import { IconButton } from "./IconButton";

interface Props {
  cwd?: string; terminals: { id: string; label: string }[]; activeId: string; output: string; outputEnd: number; exited?: boolean;
  onAdd: () => void; onSelect: (id: string) => void; onStart: (id: string, cols: number, rows: number) => void;
  onData: (data: string) => void; onResize: (cols: number, rows: number) => void; onDelete: () => void; onClose: () => void;
}

export function TerminalView({ cwd, terminals, activeId, output, outputEnd, exited, onAdd, onSelect, onStart, onData, onResize, onDelete, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | undefined>(undefined); const lastOutputEnd = useRef(0);
  const callbacks = useRef({ onData, onResize, onStart }); callbacks.current = { onData, onResize, onStart };

  useEffect(() => {
    if (!cwd || !host.current) return;
    const instance = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.25, scrollback: 5000, theme: { background: "#1d1d1b", foreground: "#e5e1d8", cursor: "#d46a24", selectionBackground: "#5a554b88", black: "#242320", red: "#d77865", green: "#72ad8d", yellow: "#c49b52", blue: "#7496b8", magenta: "#ad83ad", cyan: "#72aaa9", white: "#e5e1d8" } });
    const fit = new FitAddon(); instance.loadAddon(fit); instance.open(host.current); terminal.current = instance;
    const fitAndResize = () => { try { fit.fit(); callbacks.current.onResize(instance.cols, instance.rows); } catch { /* The panel may be between layouts. */ } };
    fit.fit(); callbacks.current.onStart(activeId, instance.cols, instance.rows); instance.focus();
    const data = instance.onData((value) => callbacks.current.onData(value)); const resize = instance.onResize(({ cols, rows }) => callbacks.current.onResize(cols, rows));
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fitAndResize); observer?.observe(host.current); window.addEventListener("resize", fitAndResize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fitAndResize); data.dispose(); resize.dispose(); instance.dispose(); terminal.current = undefined; lastOutputEnd.current = 0; };
  }, [activeId, cwd]);

  useEffect(() => {
    const instance = terminal.current; if (!instance) return;
    const outputStart = outputEnd - output.length;
    if (lastOutputEnd.current >= outputStart && lastOutputEnd.current <= outputEnd) instance.write(output.slice(lastOutputEnd.current - outputStart)); else { instance.reset(); instance.write(output); }
    lastOutputEnd.current = outputEnd;
  }, [output, outputEnd]);

  return <section className="terminal-shell" aria-label="Session terminal"><header><div className="terminal-tabs">{terminals.map((item) => <button key={item.id} className={`terminal-tab ${item.id === activeId ? "active" : ""}`} onClick={() => onSelect(item.id)}><TerminalSquare size={14} /><strong>{item.label}</strong></button>)}<IconButton label="Add terminal" onClick={onAdd}><Plus size={16} /></IconButton></div><div>{exited && <span className="terminal-exited">exited</span>}<IconButton label="Delete terminal" onClick={onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={onClose}><X size={16} /></IconButton></div></header>
    {cwd ? <div className="terminal-host" ref={host} onMouseDown={() => terminal.current?.focus()} /> : <div className="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
