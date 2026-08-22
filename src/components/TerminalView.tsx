import { useEffect, useRef, useState } from "react";
import { Play, Plus, Square, TerminalSquare, Trash2, X } from "lucide-react";
import { IconButton } from "./IconButton";

export interface TerminalRun { id: string; command: string; output: string; running: boolean; exitCode?: number; }
export function TerminalView({ cwd, terminals, activeId, runs, onAdd, onSelect, onRun, onAbort, onClear, onClose }: { cwd: string; terminals: { id: string; label: string }[]; activeId: string; runs: TerminalRun[]; onAdd: () => void; onSelect: (id: string) => void; onRun: (command: string) => void; onAbort: () => void; onClear: () => void; onClose: () => void }) {
  const [command, setCommand] = useState(""); const running = runs.some((run) => run.running);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [runs]);
  const submit = () => { if (!command.trim() || running) return; onRun(command.trim()); setCommand(""); };
  return <section className="terminal-shell" aria-label="Session terminal"><header><div className="terminal-tabs">{terminals.map((terminal) => <button key={terminal.id} className={`terminal-tab ${terminal.id === activeId ? "active" : ""}`} onClick={() => onSelect(terminal.id)}><TerminalSquare size={14} /><strong>{terminal.label}</strong>{terminal.id === activeId && <code title={cwd}>{cwd}</code>}</button>)}<IconButton label="Add terminal" onClick={onAdd}><Plus size={16} /></IconButton></div><div><IconButton label="Clear terminal" onClick={onClear}><Trash2 size={15} /></IconButton><IconButton label="Close terminal" onClick={onClose}><X size={16} /></IconButton></div></header>
    <div className="terminal-output" ref={output}>{!runs.length && <div className="terminal-empty"><span>Run a command in this session's project.</span></div>}{runs.map((run) => <section key={run.id}><div className="terminal-command"><span>›</span>{run.command}{run.running ? <i>running</i> : <i className={run.exitCode === 0 ? "success" : "failure"}>exit {run.exitCode ?? "?"}</i>}</div>{run.output && <pre>{run.output}</pre>}</section>)}</div>
    <div className="terminal-input"><span>›</span><input aria-label="Terminal command" placeholder="Enter a shell command" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} />{running ? <button className="terminal-run stop" onClick={onAbort}><Square size={13} />Stop</button> : <button className="terminal-run" disabled={!command.trim()} onClick={submit}><Play size={13} />Run</button>}</div>
  </section>;
}
