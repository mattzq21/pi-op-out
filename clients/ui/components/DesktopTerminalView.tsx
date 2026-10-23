import { reportBackgroundError } from "../lib/backgroundErrors";
import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef, type CSSProperties } from "../lib/solid";

import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";
import { ResizableTerminalPanel } from "./ResizableTerminalPanel";
import { z } from "zod";
import { terminalTheme } from "../lib/terminalColors";

import type { TerminalViewProps } from "./TerminalView";
import { copyText } from "../lib/clipboard";

const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_CELLS = 250_000;

const terminalSizeSchema = z.tuple([z.literal(8), z.number().int().min(1).max(1000), z.number().int().min(1).max(1000)]);

export function DesktopTerminalView(componentProps: TerminalViewProps) {
  const [copyError, setCopyError] = createSignal(false);
  const [draftStyle, setDraftStyle] = createSignal<CSSProperties>({ display: "none" });
  const terminalMount = createRef<HTMLDivElement>(null);
  const userInput = createRef(false);
  const queueOutput = createRef<((data: string, end: number, reset: boolean, transcript: string) => void) | undefined>(undefined);
  const resizeToHost = createRef<(() => void) | undefined>(undefined);
  const host = createRef<HTMLDivElement>(null); const terminal = createRef<Terminal | undefined>(undefined); const lastOutputEnd = createRef(0); const queuedOutputEnd = createRef(0); const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const callbacks = createRef({ onData: componentProps.onData, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }); createComputed(() => { callbacks.current = { onData: componentProps.onData, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }; });

  createDependencyEffect(() => { const capturedCwd0 = componentProps.cwd; const capturedSnapshot1 = componentProps.snapshot; const capturedSnapshotEnd2 = componentProps.snapshotEnd;
    const saveSnapshot = componentProps.onSnapshot;

    if (!capturedCwd0 || !host.current || !terminalMount.current) return;
    userInput.current = false;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const instance = new Terminal({ windowOptions: { setWinSizeChars: true }, cursorBlink: true, convertEol: false, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.25, scrollback: 5000, theme: { ...terminalTheme, cursor: accent } });
    const fit = new FitAddon(); const serializer = new SerializeAddon(); instance.loadAddon(fit); instance.loadAddon(serializer); instance.open(terminalMount.current); terminal.current = instance;
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
            try { await copyText(selection); }
            catch { if (terminal.current === instance) setCopyError(true); }
          };

          void copy();
        }
      }

      return false;
    });

    const sizeHandler = instance.parser.registerCsiHandler({ final: "t" }, params => {
      const size = terminalSizeSchema.safeParse(params);

      if (!size.success) return params[0] === 8;
      const [, rows, cols] = size.data;

      if (rows * cols > MAX_TERMINAL_CELLS) return true;
      instance.resize(cols, rows);

      return true;
    });

    if (!componentProps.started) fit.fit();
    let restored = !capturedSnapshot1;
    let pending: { data: string; end: number; reset: boolean }[] = [];
    let pendingBytes = 0;
    let writing = false;

    const drain = () => {
      if (writing || terminal.current !== instance) return;
      const chunk = pending.shift();

      if (!chunk) return;
      writing = true;

      try {
        if (chunk.reset) { restored = false; instance.reset(); }
        instance.write(chunk.data, () => {
          pendingBytes -= chunk.data.length * 2;
          writing = false;

          if (terminal.current !== instance) return;
          lastOutputEnd.current = chunk.end;
          restored = true;
          drain();
        });
      } catch (reason) {
        pending = [];
        pendingBytes = 0;
        writing = false;
        queuedOutputEnd.current = lastOutputEnd.current;
        reportBackgroundError("Could not render terminal output", reason);
      }
    };

    queueOutput.current = (data, end, reset, transcript) => {
      if (pendingBytes + data.length * 2 > MAX_PENDING_OUTPUT_BYTES) {
        pendingBytes -= pending.reduce((bytes, chunk) => bytes + chunk.data.length * 2, 0);
        pending = [];
        data = transcript;
        reset = true;
      }

      pending.push({ data, end, reset });
      pendingBytes += data.length * 2;
      queuedOutputEnd.current = end;
      drain();
    };

    if (capturedSnapshot1) queueOutput.current(capturedSnapshot1, capturedSnapshotEnd2 ?? 0, false, capturedSnapshot1);

    instance.options.disableStdin = Boolean(componentProps.ownershipRequired);
    const markUserInput = () => { if (!componentProps.ownershipRequired) userInput.current = true; };
    const keyInput = instance.onKey(markUserInput);
    const inputHost = terminalMount.current;
    const inputEvents = ['input', 'paste', 'compositionend'] as const;
    for (const event of inputEvents) inputHost.addEventListener(event, markUserInput, true);
    const mouseInput = () => { if (instance.modes.mouseTrackingMode !== 'none') markUserInput(); };
    const mouseEvents = ['mousedown', 'mouseup', 'mousemove', 'wheel'] as const;
    for (const event of mouseEvents) inputHost.addEventListener(event, mouseInput, true);
    const data = instance.onData((value) => { if (!componentProps.ownershipRequired) callbacks.current.onData(value, false, userInput.current); });
    let cursorFrame: number | undefined;

    const positionDraft = () => {
      const viewport = host.current;
      const screen = instance.element?.querySelector<HTMLElement>(".xterm-screen");

      if (!viewport || !screen) return;
      const buffer = instance.buffer.active;
      const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
      const screenRect = screen.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      setDraftStyle({
        display: row < 0 || row >= instance.rows ? "none" : "block",
        left: `${screenRect.left - viewportRect.left + viewport.scrollLeft - viewport.clientLeft}px`,
        top: `${screenRect.top - viewportRect.top + viewport.scrollTop - viewport.clientTop + row * screen.clientHeight / instance.rows}px`,
        width: `${screen.clientWidth}px`,
        "text-indent": `${Math.min(buffer.cursorX, instance.cols) * screen.clientWidth / instance.cols}px`,
        "line-height": `${screen.clientHeight / instance.rows}px`,
      });
    };

    const revealCursor = () => {
      if (cursorFrame !== undefined) cancelAnimationFrame(cursorFrame);
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = undefined;
        const viewport = host.current;
        const screen = instance.element?.querySelector<HTMLElement>(".xterm-screen");
        const buffer = instance.buffer.active;

        if (!viewport || !screen || buffer.viewportY !== buffer.baseY) return;
        const cellWidth = screen.clientWidth / instance.cols;
        const cellHeight = screen.clientHeight / instance.rows;
        const screenRect = screen.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        const left = screenRect.left - viewportRect.left + viewport.scrollLeft - viewport.clientLeft + Math.min(buffer.cursorX, instance.cols - 1) * cellWidth;
        const top = screenRect.top - viewportRect.top + viewport.scrollTop - viewport.clientTop + buffer.cursorY * cellHeight;
        viewport.scrollLeft = Math.max(Math.min(viewport.scrollLeft, left), left + cellWidth - viewport.clientWidth);
        viewport.scrollTop = Math.max(Math.min(viewport.scrollTop, top), top + cellHeight - viewport.clientHeight);
      });
    };

    const cursor = instance.onCursorMove(revealCursor);
    const draftRender = instance.onRender(positionDraft);
    const draftScroll = instance.onScroll(positionDraft);
    let resizeTimer: number | undefined;
    let requestedSize: string | undefined;

    const fitShell = () => {
      if (componentProps.ownershipRequired || !componentProps.started || componentProps.exited) return;
      const size = fit.proposeDimensions();

      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      const key = `${size.cols}:${size.rows}`;

      if (key === requestedSize) return;
      requestedSize = key;
      void componentProps.onResize?.(size.cols, size.rows).catch(() => { requestedSize = undefined; });
    };

    const scheduleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitShell, 150);
      revealCursor();
    };

    resizeToHost.current = () => { requestedSize = undefined; scheduleResize(); };

    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleResize); observer?.observe(host.current);

    return () => { saveSnapshot(restored ? `\u001b[8;${instance.rows};${instance.cols}t${serializer.serialize()}` : capturedSnapshot1 || "", restored ? lastOutputEnd.current : capturedSnapshotEnd2 ?? 0); observer?.disconnect();
    window.clearTimeout(resizeTimer); resizeToHost.current = undefined; queueOutput.current = undefined; pending = [];

    for (const event of inputEvents) inputHost.removeEventListener(event, markUserInput, true);
    for (const event of mouseEvents) inputHost.removeEventListener(event, mouseInput, true);
    keyInput.dispose();
    if (cursorFrame !== undefined) cancelAnimationFrame(cursorFrame); cursor.dispose(); draftRender.dispose(); draftScroll.dispose(); data.dispose(); sizeHandler.dispose(); instance.dispose(); terminal.current = undefined; lastOutputEnd.current = 0; queuedOutputEnd.current = 0; };
  }, () => [componentProps.activeId, componentProps.cwd]);

  createDependencyEffect(() => {
    const instance = terminal.current;

    if (!instance) return;
    instance.options.disableStdin = Boolean(componentProps.ownershipRequired);

    if (componentProps.ownershipRequired) instance.blur();
    else if (componentProps.visible !== false && !componentProps.started && !componentProps.exited) { userInput.current = false; callbacks.current.onStart(componentProps.activeId, instance.cols, instance.rows); }
    resizeToHost.current?.();
  }, () => [componentProps.activeId, componentProps.cwd, componentProps.ownershipRequired, componentProps.started, componentProps.exited, componentProps.visible]);

  createDependencyEffect(() => {
    const instance = terminal.current;

    if (!instance) return;

    if (componentProps.visible === false) { instance.blur();

      return; }

    resizeToHost.current?.();

    const frame = requestAnimationFrame(() => {
      if (terminal.current === instance && componentProps.visible !== false && !componentProps.ownershipRequired) instance.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, () => [componentProps.visible, componentProps.activeId, componentProps.cwd, componentProps.ownershipRequired]);

  createDependencyEffect(() => { const capturedOutputEnd0 = componentProps.outputEnd; const capturedOutput1 = componentProps.output;
    const instance = terminal.current;

    if (!instance) return;
    const outputStart = capturedOutputEnd0 - capturedOutput1.length;

    if (capturedOutputEnd0 <= queuedOutputEnd.current) return;

    const reset = queuedOutputEnd.current < outputStart;
    const data = reset ? capturedOutput1 : capturedOutput1.slice(queuedOutputEnd.current - outputStart);
    queueOutput.current?.(data, capturedOutputEnd0, reset, capturedOutput1);
  }, () => [componentProps.output, componentProps.outputEnd]);
  createDependencyEffect(() => {
    const capturedActiveId0 = componentProps.activeId;

    if (componentProps.visible !== false) tabRefs.current.get(capturedActiveId0)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, () => [componentProps.visible, componentProps.activeId, componentProps.terminals.length]);

  const canAdd = createMemo(() => (componentProps.terminals.length < 8));
  let takingOwnership = false;

  const takeOwnership = async () => {
    if (!componentProps.ownershipRequired || takingOwnership) return;
    const instance = terminal.current;
    takingOwnership = true;

    try {
      await componentProps.onTakeOwnership?.();

      if (terminal.current === instance && !componentProps.ownershipRequired) instance?.focus();
    } finally { takingOwnership = false; }
  };

  return <ResizableTerminalPanel><header><div class="terminal-tabs">{<Key each={componentProps.terminals} by={(item) => item.id}>{(item, _index) => <button ref={(element) => { if (element) tabRefs.current.set(item().id, element); else tabRefs.current.delete(item().id); }}  class={`terminal-tab ${item().id === componentProps.activeId ? "active" : ""}`} aria-pressed={item().id === componentProps.activeId} onClick={() => componentProps.onSelect(item().id)}><TerminalSquare size={14} /><strong>{item().label}</strong></button>}</Key>}<IconButton label={canAdd() ? "Add terminal" : "Terminal limit reached"} disabled={componentProps.ownershipRequired || !canAdd()} onClick={componentProps.onAdd}><Plus size={16} /></IconButton></div><div>{copyError() && <span class="copy-feedback" role="status">Could not copy terminal selection</span>}{componentProps.exited && <><span class="terminal-exited">exited</span><IconButton label="Restart terminal" disabled={componentProps.ownershipRequired} onClick={() => componentProps.onStart(componentProps.activeId, terminal.current?.cols ?? 80, terminal.current?.rows ?? 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" disabled={componentProps.ownershipRequired} onClick={componentProps.onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={componentProps.onClose}><X size={16} /></IconButton></div></header>
    {componentProps.cwd ? <div class="terminal-surface" classList={{ "ownership-required": Boolean(componentProps.ownershipRequired) }}><div class="terminal-host" ref={element => { host.current = element; }} onMouseDown={() => terminal.current?.focus()} onFocusIn={() => { void takeOwnership(); }}><div class="terminal-mount" ref={element => { terminalMount.current = element; }} />{componentProps.ownershipRequired && componentProps.inputDraft && <div class="terminal-draft-inline" style={draftStyle()}>{componentProps.inputDraft}</div>}</div></div> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </ResizableTerminalPanel>;
}
