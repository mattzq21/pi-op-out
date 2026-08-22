import { useState } from "react";
import { Play, Square, TerminalSquare, Trash2 } from "lucide-react";
import { IconButton } from "./IconButton";

export interface TerminalRun { id: string; command: string; output: string; running: boolean; exitCode?: number; }
export function TerminalView({ cwd, runs, onRun, onAbort, onClear }: { cwd: string; runs: TerminalRun[]; onRun: (command: string) => void; onAbort: () => void; onClear: () => void }) {
  const [command, setCommand] = useState(""); const running = runs.some((run) => run.running);
  const submit = () => { if (!command.trim() || running) return; onRun(command.trim()); setCommand(""); };
  return <main className="terminal-shell"><header><div><p className="eyebrow">Project shell</p><h1>Terminal</h1><code>{cwd}</code></div><IconButton label="Clear terminal" onClick={onClear}><Trash2 size={17} /></IconButton></header>
    <div className="terminal-output">{!runs.length && <div className="terminal-empty"><TerminalSquare size={28} /><span>Run a command in the active Pi project.</span><small>Output is added to agent context for your next prompt.</small></div>}{runs.map((run) => <section key={run.id}><div className="terminal-command"><span>›</span>{run.command}{run.running ? <i>running</i> : <i className={run.exitCode === 0 ? "success" : "failure"}>exit {run.exitCode ?? "?"}</i>}</div>{run.output && <pre>{run.output}</pre>}</section>)}</div>
    <div className="terminal-input"><span>›</span><input aria-label="Terminal command" placeholder="Enter a shell command" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} />{running ? <button className="terminal-run stop" onClick={onAbort}><Square size={13} />Stop</button> : <button className="terminal-run" disabled={!command.trim()} onClick={submit}><Play size={13} />Run</button>}</div>
  </main>;
}
