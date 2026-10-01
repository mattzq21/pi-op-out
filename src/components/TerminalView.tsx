import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";
import { createTerminalTranscript } from "../lib/terminalTranscript";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";

interface Props {
  ownershipRequired?: boolean; onTakeOwnership?: () => Promise<void>;
  cwd?: string; terminals: { id: string; label: string }[]; activeId: string; output: string; outputEnd: number; started: boolean; exited?: boolean;
  onAdd: () => void; onSelect: (id: string) => void; onStart: (id: string, cols: number, rows: number) => void;
  onData: (data: string) => void; onDelete: () => void; onClose: () => void;
}

export function TerminalView(componentProps: Props) {
  const [command, setCommand] = createSignal("");
  const host = createRef<HTMLPreElement>(null);
  const input = createRef<HTMLInputElement>(null);
  const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const history: string[] = [];
  let historyIndex = 0;
  let draft = "";
  let followOutput = true;
  let parser = createTerminalTranscript();
  let parsedId = "";
  let parsedEnd = 0;
  const transcript = createMemo(() => {
    const start = componentProps.outputEnd - componentProps.output.length;
    if (parsedId !== componentProps.activeId || parsedEnd < start || parsedEnd > componentProps.outputEnd) {
      parser = createTerminalTranscript();
      parsedEnd = start;
      parsedId = componentProps.activeId;
    }
    const text = parser.append(componentProps.output.slice(parsedEnd - start));
    parsedEnd = componentProps.outputEnd;
    return text;
  });
  const disabled = () => Boolean(componentProps.ownershipRequired || !componentProps.started || componentProps.exited);
  const canAdd = createMemo(() => componentProps.terminals.length < 8);

  createDependencyEffect(() => {
    if (componentProps.cwd && !componentProps.ownershipRequired && !componentProps.started && !componentProps.exited) componentProps.onStart(componentProps.activeId, 80, 24);
  }, () => [componentProps.activeId, componentProps.cwd, componentProps.ownershipRequired]);

  createDependencyEffect(() => {
    if (followOutput && host.current) host.current.scrollTop = host.current.scrollHeight;
  }, () => [transcript()]);

  createDependencyEffect(() => {
    setCommand(""); history.length = 0; historyIndex = 0; draft = ""; followOutput = true;
    tabRefs.current.get(componentProps.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, () => [componentProps.activeId]);

  const send = () => {
    if (disabled()) return;
    const value = command();
    componentProps.onData(value + "\r");
    if (value && history.at(-1) !== value) { history.push(value); if (history.length > 100) history.shift(); }
    historyIndex = history.length; draft = ""; setCommand(""); followOutput = true;
    if (host.current) host.current.scrollTop = host.current.scrollHeight;
    input.current?.focus();
  };
  const interrupt = () => {
    if (disabled()) return;
    componentProps.onData("\u0003"); setCommand(""); historyIndex = history.length; draft = "";
    input.current?.focus();
  };

  return <section class="terminal-shell" aria-label="Session terminal"><header><div class="terminal-tabs">{<Key each={componentProps.terminals} by={(item) => item.id}>{(item, _index) => <button ref={(element) => { if (element) tabRefs.current.set(item().id, element); else tabRefs.current.delete(item().id); }}  class={`terminal-tab ${item().id === componentProps.activeId ? "active" : ""}`} aria-pressed={item().id === componentProps.activeId} onClick={() => componentProps.onSelect(item().id)}><TerminalSquare size={14} /><strong>{item().label}</strong></button>}</Key>}<IconButton label={canAdd() ? "Add terminal" : "Terminal limit reached"} disabled={componentProps.ownershipRequired || !canAdd()} onClick={componentProps.onAdd}><Plus size={16} /></IconButton></div><div>{componentProps.exited && <><span class="terminal-exited">exited</span><IconButton label="Restart terminal" disabled={componentProps.ownershipRequired} onClick={() => componentProps.onStart(componentProps.activeId, 80, 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" disabled={componentProps.ownershipRequired} onClick={componentProps.onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={componentProps.onClose}><X size={16} /></IconButton></div></header>
    {componentProps.cwd ? <div class="terminal-transcript-body">
      <pre class="terminal-transcript" aria-label="Terminal output" tabIndex={0} ref={element => { host.current = element; }} onScroll={() => {
        const element = host.current;
        if (element) followOutput = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}>{transcript()}</pre>
      {componentProps.ownershipRequired
        ? <button class="terminal-take-ownership" onClick={async () => { await componentProps.onTakeOwnership?.(); input.current?.focus(); }}>Take session ownership to send commands</button>
        : <form class="terminal-command" onSubmit={event => { event.preventDefault(); send(); }}>
          <input ref={element => { input.current = element; }} aria-label="Terminal command" placeholder="Enter a command" value={command()} disabled={disabled()} autocomplete="off" autocapitalize="off" spellcheck={false} onInput={event => setCommand(event.currentTarget.value)} onKeyDown={event => {
            if (event.isComposing) return;
            if (event.ctrlKey && event.key.toLowerCase() === "c" && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) { event.preventDefault(); interrupt(); }
            if ((event.key === "ArrowUp" || event.key === "ArrowDown") && history.length) {
              event.preventDefault();
              if (historyIndex === history.length) draft = command();
              historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === "ArrowUp" ? -1 : 1)));
              setCommand(historyIndex === history.length ? draft : history[historyIndex]);
            }
          }} />
          <button type="submit" disabled={disabled()}>Send</button>
          <button type="button" disabled={disabled()} onClick={interrupt}>Ctrl+C</button>
          <button type="button" disabled={disabled()} onClick={() => { componentProps.onData("\u0004"); input.current?.focus(); }}>Ctrl+D</button>
        </form>}
    </div> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
