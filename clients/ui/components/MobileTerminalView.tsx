import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";
import { createTerminalTranscript } from "../lib/terminalTranscript";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";

import type { TerminalViewProps } from "./TerminalView";

const endOfHistory = "\u001b>";
const historyReplyTime = 2000;

function sharedStart(first: string, second: string) {
  let index = 0;

  while (index < first.length && first[index] === second[index]) index++;

  return index;
}

export function MobileTerminalView(componentProps: TerminalViewProps) {
  const [command, setCommand] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const host = createRef<HTMLDivElement>(null);
  const input = createRef<HTMLSpanElement>(null);
  const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const [recall, setRecall] = createSignal<{ terminal: string; prompt: string; draft: string }>();
  const awayTerminals = new Set<string>();
  let lineWaiter: { outputEnd: number; before: string; created: number; resolve: (line: string | undefined) => void } | undefined;
  let historyMove: Promise<void> | undefined;
  let followOutput = true;
  let parser = createTerminalTranscript();
  let parsedId = "";
  let parsedEnd = 0;
  let commandRevision = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    lineWaiter?.resolve(undefined);

    if (untrack(recall)) void componentProps.onData(endOfHistory);
  });

  const transcript = createMemo(() => {
    const start = componentProps.outputEnd - componentProps.output.length;

    if (parsedId !== componentProps.activeId || parsedEnd < start || parsedEnd > componentProps.outputEnd) {
      parser = createTerminalTranscript();
      parsedEnd = start;
      parsedId = componentProps.activeId;
    }

    parser.append(componentProps.output.slice(parsedEnd - start));
    parsedEnd = componentProps.outputEnd;

    return { line: parser.currentLine(), outputEnd: componentProps.outputEnd };
  });

  const segments = createMemo(() => {
    transcript();
    const current = recall();

    return parser.segments(current?.terminal === componentProps.activeId ? current.prompt.length : undefined);
  });

  createDependencyEffect(() => {
    const waiter = lineWaiter;
    const { line, outputEnd } = transcript();

    if (!waiter || outputEnd <= waiter.outputEnd) return;
    waiter.resolve(line === waiter.before ? undefined : line);
  }, () => [transcript()]);

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
    setCommand(""); followOutput = true;
    lineWaiter?.resolve(undefined);
    const current = untrack(recall);

    if (current && current.terminal !== componentProps.activeId) { awayTerminals.add(current.terminal); setRecall(undefined); }

    if (componentProps.visible !== false) tabRefs.current.get(componentProps.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, () => [componentProps.activeId]);

  createDependencyEffect(() => {
    if (disabled() || !awayTerminals.delete(componentProps.activeId)) return;
    void componentProps.onData(endOfHistory);
  }, () => [componentProps.activeId, disabled()]);

  const shellAway = () => Boolean(recall() || lineWaiter);

  const finishInput = (revision: number) => {
    if (revision !== commandRevision) return;
    commandRevision++;
    setCommand(""); followOutput = true;

    if (host.current) host.current.scrollTop = host.current.scrollHeight;
    input.current?.focus();
  };

  const submit = async (interrupting = false) => {
    if (disabled() || sending()) return;
    const id = componentProps.activeId;
    setSending(true);
    let accepted;
    let value = command();
    let revision = commandRevision;

    try {
      if (historyMove) { await historyMove; value = command(); revision = commandRevision; }

      accepted = await componentProps.onData(interrupting ? "\u0003" : (shellAway() ? endOfHistory : "") + value + "\r", true);
    }
    finally { if (!disposed) setSending(false); }

    if (!accepted || disposed || componentProps.activeId !== id) return;
    lineWaiter?.resolve(undefined); setRecall(undefined);
    finishInput(revision);
  };

  let restoredRevision = 0;
  createDependencyEffect(() => {
    restoredRevision = ++commandRevision;
  }, () => [componentProps.activeId, componentProps.ownershipRequired]);

  createDependencyEffect(() => {
    if (commandRevision !== restoredRevision) return;
    setCommand(componentProps.inputDraft ?? "");
  }, () => [componentProps.activeId, componentProps.ownershipRequired, componentProps.inputDraft]);

  const send = () => { void submit(); };

  const interrupt = () => { void submit(true); };

  const sendControl = (data: string) => {
    if (disabled()) return;

    if (data === "\u0003") {
      interrupt();

      return;
    }

    const leaveHistory = shellAway();
    lineWaiter?.resolve(undefined); setRecall(undefined);
    componentProps.onData((leaveHistory ? endOfHistory : "") + data);
    input.current?.focus();
  };

  const editCommand = (value: string) => {
    commandRevision++;
    setCommand(value);
    componentProps.onDraft(value);
  };

  const showCommand = (value: string) => {
    editCommand(value);
    const element = input.current;

    if (!element) return;
    element.textContent = value;

    if (document.activeElement !== element) return;
    const range = document.createRange();
    range.selectNodeContents(element); range.collapse(false);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  };

  const historyLine = (key: string, before: string) => {
    const outputEnd = componentProps.outputEnd; const sendData = componentProps.onData;

    return new Promise<string | undefined>(resolve => {
      lineWaiter?.resolve(undefined);
      const waiter = { outputEnd, before, created: Date.now(), resolve: (line: string | undefined) => {
        if (lineWaiter === waiter) lineWaiter = undefined;
        resolve(line);
      } };
      lineWaiter = waiter;
      sendData(key).then(accepted => { if (!accepted) waiter.resolve(undefined); }, () => waiter.resolve(undefined));
    });
  };

  const moveHistory = async (direction: -1 | 1) => {
    if (disabled() || sending() || (lineWaiter && Date.now() - lineWaiter.created < historyReplyTime)) return;
    const current = recall();

    if (!current && direction > 0) return;
    const id = componentProps.activeId;
    const before = transcript().line;
    const prompt = current?.prompt ?? before;
    const draft = current?.draft ?? command();
    const pending = historyLine(direction < 0 ? "\u001b[A" : "\u001b[B", before);
    const move = pending.then(line => {
      if (line === undefined || disposed || componentProps.activeId !== id || /\^\[\[[AB]$/.test(line)) return;

      if (line === prompt) { setRecall(undefined); showCommand(draft); return; }
      setRecall({ terminal: id, prompt, draft });
      showCommand(line.startsWith(prompt) ? line.slice(prompt.length) : line.slice(sharedStart(line, prompt)));
    });
    historyMove = move;
    await move;

    if (historyMove === move) historyMove = undefined;
  };

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
      }}><span><Key each={segments()} by="id">{segment => <span style={segment().style}>{segment().text}</span>}</Key></span>{!componentProps.ownershipRequired &&
        <form class="terminal-command" onSubmit={event => { event.preventDefault(); send(); }}>
          <span ref={element => { input.current = element; element.textContent = command(); }} role="textbox" aria-label="Terminal command" aria-multiline="true" aria-disabled={disabled()} tabIndex={disabled() ? -1 : 0} contentEditable={disabled() ? false : "plaintext-only"} autocapitalize="off" spellcheck={false} onInput={event => acceptInput(event.currentTarget, event.isComposing)} onCompositionEnd={event => acceptInput(event.currentTarget, false)} onKeyDown={event => {
            if (event.isComposing) return;

            if (event.key === "Enter") { event.preventDefault(); send(); }

            if (event.ctrlKey && event.key.toLowerCase() === "c" && window.getSelection()?.isCollapsed) { event.preventDefault(); interrupt(); }
          }} />
        </form>}
      </div>
      <div class="terminal-controls" role="group" aria-label="Terminal controls">
        <button type="button" disabled={disabled() || sending()} onClick={send}>Send</button>
        <Key each={[["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["Ctrl+D", "\u0004"]]} by={entry => entry[0]}>{entry =>
          <button type="button" disabled={disabled()} onPointerDown={event => event.preventDefault()} onClick={() => sendControl(entry()[1])}>{entry()[0]}</button>
        }</Key>
        <button type="button" disabled={disabled()} onPointerDown={event => event.preventDefault()} onClick={() => { void moveHistory(-1); }}>↑</button>
        <button type="button" disabled={disabled()} onPointerDown={event => event.preventDefault()} onClick={() => { void moveHistory(1); }}>↓</button>
      </div>

    </div> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </section>;
}
