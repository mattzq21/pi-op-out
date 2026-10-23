import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";
import { createTerminalTranscript } from "../lib/terminalTranscript";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";

import type { TerminalViewProps } from "./TerminalView";

export function MobileTerminalView(componentProps: TerminalViewProps) {
  const [command, setCommand] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const host = createRef<HTMLDivElement>(null);
  const input = createRef<HTMLSpanElement>(null);
  const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const history: string[] = [];
  let historyIndex = 0;
  let draft = "";
  let followOutput = true;
  let parser = createTerminalTranscript();
  let parsedId = "";
  let parsedEnd = 0;
  let commandRevision = 0;
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const transcript = createMemo(() => {
    const start = componentProps.outputEnd - componentProps.output.length;

    if (parsedId !== componentProps.activeId || parsedEnd < start || parsedEnd > componentProps.outputEnd) {
      parser = createTerminalTranscript();
      parsedEnd = start;
      parsedId = componentProps.activeId;
    }

    const text = parser.append(componentProps.output.slice(parsedEnd - start));
    parsedEnd = componentProps.outputEnd;

    return { text, segments: parser.segments() };
  });

  const disabled = () => Boolean(componentProps.ownershipRequired || !componentProps.started || componentProps.exited);
  const canAdd = createMemo(() => componentProps.terminals.length < 8);

  createDependencyEffect(() => {
    const element = input.current;

    if (element && element.textContent !== command()) element.textContent = command();
  }, () => [command(), componentProps.ownershipRequired]);

  createDependencyEffect(() => {
    if (componentProps.visible !== false && componentProps.cwd && !componentProps.ownershipRequired && !componentProps.started && !componentProps.exited) componentProps.onStart(componentProps.activeId, 80, 24);
  }, () => [componentProps.activeId, componentProps.cwd, componentProps.ownershipRequired, componentProps.visible]);

  createDependencyEffect(() => {
    if (followOutput && host.current) host.current.scrollTop = host.current.scrollHeight;
  }, () => [transcript()]);

  createDependencyEffect(() => {
    setCommand(""); history.length = 0; historyIndex = 0; draft = ""; followOutput = true;

    if (componentProps.visible !== false) tabRefs.current.get(componentProps.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, () => [componentProps.activeId]);

  const finishInput = (value: string, interrupting: boolean, revision: number) => {
    if (!interrupting && value && history.at(-1) !== value) {
      const atLatest = historyIndex === history.length;
      history.push(value);

      if (history.length > 100) { history.shift(); historyIndex = Math.max(0, historyIndex - 1); }

      if (atLatest) historyIndex = history.length;
    }

    if (revision !== commandRevision) return;
    commandRevision++;
    historyIndex = history.length; draft = ""; setCommand(""); followOutput = true;

    if (host.current) host.current.scrollTop = host.current.scrollHeight;
    input.current?.focus();
  };

  const submit = async (interrupting = false) => {
    if (disabled() || sending()) return;
    const value = command();
    const id = componentProps.activeId;
    const revision = commandRevision;
    setSending(true);
    let accepted;

    try { accepted = await componentProps.onData(interrupting ? "\u0003" : value + "\r", true); }
    finally { if (!disposed) setSending(false); }

    if (!accepted || disposed || componentProps.activeId !== id) return;
    finishInput(value, interrupting, revision);
  };

  let restoredRevision = 0;
  createDependencyEffect(() => {
    restoredRevision = ++commandRevision;
  }, () => [componentProps.activeId, componentProps.ownershipRequired]);

  createDependencyEffect(() => {
    if (commandRevision !== restoredRevision) return;
    setCommand(componentProps.inputDraft ?? "");
    historyIndex = history.length; draft = "";
  }, () => [componentProps.activeId, componentProps.ownershipRequired, componentProps.inputDraft]);

  const send = () => { void submit(); };

  const interrupt = () => { void submit(true); };

  const sendControl = (data: string) => {
    if (disabled()) return;

    if (data === "\u0003") {
      interrupt();

      return;
    }

    componentProps.onData(data);
    input.current?.focus();
  };

  const editCommand = (value: string) => {
    commandRevision++;
    setCommand(value);
    componentProps.onDraft(value);
  };

  const browseHistory = (direction: number) => {
    if (historyIndex === history.length) draft = command();
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    editCommand(historyIndex === history.length ? draft : history[historyIndex]);
  };

  // Android keyboards send Enter during word composition as a new line in the text, with no Enter key event.
  const acceptInput = (element: HTMLElement, composing: boolean) => {
    const value = element.textContent ?? "";

    if (!value.includes("\n")) { editCommand(value); return; }

    if (composing) return;
    const line = value.replace(/\n/g, "");
    element.textContent = line;
    editCommand(line);
    send();
  };

  let takingOwnership = false;

  const focusInput = async () => {
    if (takingOwnership) return;
    takingOwnership = true;

    try {
      if (componentProps.ownershipRequired) {
        await componentProps.onTakeOwnership?.();
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      if (!disabled()) input.current?.focus();
    } finally { takingOwnership = false; }
  };

  return <section class="terminal-shell" aria-label="Session terminal"><header><div class="terminal-tabs">{<Key each={componentProps.terminals} by={(item) => item.id}>{(item, _index) => <button ref={(element) => { if (element) tabRefs.current.set(item().id, element); else tabRefs.current.delete(item().id); }}  class={`terminal-tab ${item().id === componentProps.activeId ? "active" : ""}`} aria-pressed={item().id === componentProps.activeId} onClick={() => componentProps.onSelect(item().id)}><TerminalSquare size={14} /><strong>{item().label}</strong></button>}</Key>}<IconButton label={canAdd() ? "Add terminal" : "Terminal limit reached"} disabled={componentProps.ownershipRequired || !canAdd()} onClick={componentProps.onAdd}><Plus size={16} /></IconButton></div><div>{componentProps.exited && <><span class="terminal-exited">exited</span><IconButton label="Restart terminal" disabled={componentProps.ownershipRequired} onClick={() => componentProps.onStart(componentProps.activeId, 80, 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" disabled={componentProps.ownershipRequired} onClick={componentProps.onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={componentProps.onClose}><X size={16} /></IconButton></div></header>
    {componentProps.cwd ? <div class="terminal-transcript-body" classList={{ "ownership-required": Boolean(componentProps.ownershipRequired) }}>
      <div class="terminal-transcript" aria-label="Terminal output" tabIndex={0} ref={element => { host.current = element; }} onClick={event => {
        if (event.target === input.current) return;
        const selection = window.getSelection();

        if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
        void focusInput();
      }} onKeyDown={event => {
        if (event.target !== event.currentTarget) return;

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void focusInput();
        }
      }} onScroll={() => {
        const element = host.current;

        if (element) followOutput = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}><span><Key each={transcript().segments} by="id">{segment => <span style={segment().style}>{segment().text}</span>}</Key></span>{!componentProps.ownershipRequired &&
        <form class="terminal-command" onSubmit={event => { event.preventDefault(); send(); }}>
          <span ref={element => { input.current = element; element.textContent = command(); }} role="textbox" aria-label="Terminal command" aria-multiline="true" aria-disabled={disabled()} tabIndex={disabled() ? -1 : 0} contentEditable={disabled() ? false : "plaintext-only"} autocapitalize="off" spellcheck={false} onInput={event => acceptInput(event.currentTarget, event.isComposing)} onCompositionEnd={event => acceptInput(event.currentTarget, false)} onKeyDown={event => {
            if (event.isComposing) return;

            if (event.key === "Enter") { event.preventDefault(); send(); }

            if (event.ctrlKey && event.key.toLowerCase() === "c" && window.getSelection()?.isCollapsed) { event.preventDefault(); interrupt(); }

            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();

              browseHistory(event.key === "ArrowUp" ? -1 : 1);
            }
          }} />
        </form>}
      </div>
      <div class="terminal-controls" role="group" aria-label="Terminal controls">
        <button type="button" disabled={disabled() || sending()} onClick={send}>Send</button>
        <Key each={[["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["Ctrl+D", "\u0004"], ["↑", "\u001b[A"], ["↓", "\u001b[B"], ["←", "\u001b[D"], ["→", "\u001b[C"]]} by={entry => entry[0]}>{entry =>
          <button type="button" disabled={disabled()} onPointerDown={event => event.preventDefault()} onClick={() => sendControl(entry()[1])}>{entry()[0]}</button>
        }</Key>
      </div>

    </div> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
