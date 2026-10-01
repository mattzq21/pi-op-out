import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from "lucide-solid";
import { IconButton } from "./IconButton";
import { ResizableTerminalPanel } from "./ResizableTerminalPanel";
import { z } from "zod";

import type { TerminalViewProps } from "./TerminalView";

const terminalSizeSchema = z.tuple([z.literal(8), z.number().int().min(1).max(65535), z.number().int().min(1).max(65535)]);

export function DesktopTerminalView(componentProps: TerminalViewProps) {
  const [copyError, setCopyError] = createSignal(false);
  const host = createRef<HTMLDivElement>(null); const terminal = createRef<Terminal | undefined>(undefined); const lastOutputEnd = createRef(0); const queuedOutputEnd = createRef(0); const tabRefs = createRef(new Map<string, HTMLButtonElement>());
  const callbacks = createRef({ onData: componentProps.onData, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }); createComputed(() => { callbacks.current = { onData: componentProps.onData, onStart: componentProps.onStart, onSnapshot: componentProps.onSnapshot }; });

  createDependencyEffect(() => { const capturedCwd0 = componentProps.cwd; const capturedSnapshot1 = componentProps.snapshot; const capturedSnapshotEnd2 = componentProps.snapshotEnd;
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

    const sizeHandler = instance.parser.registerCsiHandler({ final: "t" }, params => {
      const size = terminalSizeSchema.safeParse(params);

      if (!size.success) return false;
      const [, rows, cols] = size.data;
      instance.resize(cols, rows);

      return true;
    });

    if (!componentProps.started) fit.fit();
    let restored = !capturedSnapshot1;

    if (capturedSnapshot1) { queuedOutputEnd.current = capturedSnapshotEnd2 ?? 0; instance.write((capturedSnapshot1), () => { if (terminal.current !== instance) return; lastOutputEnd.current = capturedSnapshotEnd2 ?? 0; restored = true; }); }

    instance.options.disableStdin = Boolean(componentProps.ownershipRequired);
    requestAnimationFrame(() => { if (terminal.current === instance && !componentProps.ownershipRequired) instance.focus(); });
    const data = instance.onData((value) => { if (!componentProps.ownershipRequired) callbacks.current.onData(value); });
    let cursorFrame: number | undefined;

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
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealCursor); observer?.observe(host.current);

    return () => { saveSnapshot(restored ? `\u001b[8;${instance.rows};${instance.cols}t${serializer.serialize()}` : capturedSnapshot1 || "", restored ? lastOutputEnd.current : capturedSnapshotEnd2 ?? 0); observer?.disconnect();

    if (cursorFrame !== undefined) cancelAnimationFrame(cursorFrame); cursor.dispose(); data.dispose(); sizeHandler.dispose(); instance.dispose(); terminal.current = undefined; lastOutputEnd.current = 0; queuedOutputEnd.current = 0; };
  }, () => [componentProps.activeId, componentProps.cwd]);

  createDependencyEffect(() => {
    const instance = terminal.current;

    if (!instance) return;
    instance.options.disableStdin = Boolean(componentProps.ownershipRequired);

    if (componentProps.ownershipRequired) instance.blur();
    else if (!componentProps.started && !componentProps.exited) callbacks.current.onStart(componentProps.activeId, instance.cols, instance.rows);
  }, () => [componentProps.activeId, componentProps.cwd, componentProps.ownershipRequired]);

  createDependencyEffect(() => { const capturedOutputEnd0 = componentProps.outputEnd; const capturedOutput1 = componentProps.output;
    const instance = terminal.current;

    if (!instance) return;
    const outputStart = capturedOutputEnd0 - capturedOutput1.length;
    const parsed = () => { if (terminal.current === instance) lastOutputEnd.current = capturedOutputEnd0; };

    if (queuedOutputEnd.current >= outputStart && queuedOutputEnd.current <= capturedOutputEnd0) instance.write(capturedOutput1.slice(queuedOutputEnd.current - outputStart), parsed); else { instance.reset(); instance.write(capturedOutput1, parsed); }

    queuedOutputEnd.current = capturedOutputEnd0;
  }, () => [componentProps.output, componentProps.outputEnd]);
  createDependencyEffect(() => {
    const capturedActiveId0 = componentProps.activeId;
 tabRefs.current.get(capturedActiveId0)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, () => [componentProps.activeId, componentProps.terminals.length]);

  const canAdd = createMemo(() => (componentProps.terminals.length < 8));

  return <ResizableTerminalPanel><header><div class="terminal-tabs">{<Key each={componentProps.terminals} by={(item) => item.id}>{(item, _index) => <button ref={(element) => { if (element) tabRefs.current.set(item().id, element); else tabRefs.current.delete(item().id); }}  class={`terminal-tab ${item().id === componentProps.activeId ? "active" : ""}`} aria-pressed={item().id === componentProps.activeId} onClick={() => componentProps.onSelect(item().id)}><TerminalSquare size={14} /><strong>{item().label}</strong></button>}</Key>}<IconButton label={canAdd() ? "Add terminal" : "Terminal limit reached"} disabled={componentProps.ownershipRequired || !canAdd()} onClick={componentProps.onAdd}><Plus size={16} /></IconButton></div><div>{copyError() && <span class="copy-feedback" role="status">Could not copy terminal selection</span>}{componentProps.exited && <><span class="terminal-exited">exited</span><IconButton label="Restart terminal" disabled={componentProps.ownershipRequired} onClick={() => componentProps.onStart(componentProps.activeId, terminal.current?.cols ?? 80, terminal.current?.rows ?? 24)}><RotateCcw size={14} /></IconButton></>}<IconButton label="Delete terminal" disabled={componentProps.ownershipRequired} onClick={componentProps.onDelete}><Trash2 size={15} /></IconButton><IconButton label="Close terminal panel" onClick={componentProps.onClose}><X size={16} /></IconButton></div></header>
    {componentProps.cwd ? <div class="terminal-surface" classList={{ "ownership-required": Boolean(componentProps.ownershipRequired) }}><div class="terminal-host" ref={element => { host.current = element; }} onMouseDown={() => { if (!componentProps.ownershipRequired) terminal.current?.focus(); }} />{componentProps.ownershipRequired && <button class="terminal-ownership" aria-label="Take session ownership" onClick={async () => { await componentProps.onTakeOwnership?.();

    if (!componentProps.ownershipRequired) terminal.current?.focus(); }} />}</div> : <div class="terminal-unavailable">Start the conversation to get a CWD</div>}
  </ResizableTerminalPanel>;
}
