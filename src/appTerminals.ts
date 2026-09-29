import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { appendTerminalOutputs, initialTerminals, MAX_TERMINALS, terminalConversationKey, type QueuedTerminalOutput, type SessionTerminals, type TerminalTarget } from "./appSupport";
import { reassignTerminals } from "./appRuntime";
import type { NativeTransport } from "./lib/nativeTransport";
import { createDependencyEffect, createRef } from "./lib/solid";
import { TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import type { RpcEvent } from "./types";

type TerminalContext = {
  transport: Accessor<NativeTransport>;
  conversation: Accessor<TerminalTarget>;
  addNotice: (notice: { title: string; message: string }) => void;
};

export function createAppTerminals({ transport, conversation, addNotice }: TerminalContext) {
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalTarget, setTerminalTarget] = createSignal<TerminalTarget>();
  const [terminalsBySession, setTerminalsBySession] = createSignal<Record<string, SessionTerminals>>({});
  const closingTerminals = createRef(new Set<string>());
  const startingTerminals = createRef(new Set<string>());
  const terminalPanelRevision = createRef(0);
  const queuedTerminalOutput = createRef(new Map<string, QueuedTerminalOutput>());
  const terminalOutputFrame = createRef<number | undefined>(undefined);
  const terminalSessionId = createMemo(() => terminalConversationKey(terminalTarget(), conversation().sessionKey));
  const terminalLocationState = createMemo(() => ({
    terminalCwd: terminalTarget()?.cwd ?? conversation().cwd,
    terminalHostId: terminalTarget()?.hostId ?? conversation().hostId,
  }));
  const sessionTerminals = createMemo(() => terminalsBySession()[terminalSessionId()] ?? initialTerminals(terminalSessionId()));
  const activeTerminal = createMemo(() => sessionTerminals().tabs.find(terminal => terminal.id === sessionTerminals().activeId) ?? sessionTerminals().tabs[0]);
  const terminalState = () => ({ sessionTerminals: sessionTerminals(), activeTerminal: activeTerminal() });
  const viewKey = createMemo(() => `${terminalSessionId()}:${activeTerminal().id}`);
  const flushTerminalOutput = () => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();
    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  };
  const queueTerminalOutput = (terminalId: string, data: string) => {
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });
    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 0);
  };
  const startTerminal = async (terminalId: string, cols: number, rows: number) => { const capturedTerminalSessionId = terminalSessionId(); const capturedTerminalLocationState = { ...terminalLocationState() }; const capturedTransport = transport();
    if (startingTerminals.current.has(terminalId)) return; startingTerminals.current.add(terminalId);
    const sessionKey = capturedTerminalSessionId;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = capturedTerminalLocationState.terminalCwd;
    if (!cwd) { startingTerminals.current.delete(terminalId); setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n"); return; }
    try { await capturedTransport.startTerminal(terminalId, sessionKey, cwd, cols, rows, capturedTerminalLocationState.terminalHostId); } catch (reason) { setTerminalsBySession((current) => { const session = current[sessionKey]; return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); } finally { startingTerminals.current.delete(terminalId); }
  };
  const addTerminal = () => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); if (session.tabs.length >= MAX_TERMINALS) return current; const id = `terminal-${sessionKey}-${crypto.randomUUID()}`; return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };
  const selectTerminal = (terminalId: string) => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };
  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number) => { setTerminalsBySession((current) => { const session = current[sessionKey]; if (!session?.tabs.some((terminal) => terminal.id === terminalId)) return current; return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };
  const deleteTerminal = async () => { const capturedComposerState = { ...terminalState() }; const capturedTerminalSessionId = terminalSessionId(); const capturedTransport = transport();
    const terminalId = capturedComposerState.activeTerminal.id; const closingLast = capturedComposerState.sessionTerminals.tabs.length === 1; const panelTarget = capturedTerminalSessionId; const panelRevision = terminalPanelRevision.current;
    if (closingTerminals.current.has(terminalId)) return; closingTerminals.current.add(terminalId);
    try { await capturedTransport.closeTerminal(terminalId); } catch (reason) { addNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) }); return; }
    finally { closingTerminals.current.delete(terminalId); }
    if (closingLast && terminalSessionId() === panelTarget && terminalPanelRevision.current === panelRevision) setTerminalOpen(false);
    const sessionKey = panelTarget;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); const removedIndex = session.tabs.findIndex((terminal) => terminal.id === terminalId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current }; if (!tabs.length) delete next[sessionKey]; else next[sessionKey] = { activeId: session.activeId !== terminalId && tabs.some((tab) => tab.id === session.activeId) ? session.activeId : tabs[Math.min(Math.max(0, removedIndex), tabs.length - 1)].id, tabs }; return next; });
  };

  const flush = () => {
    if (terminalOutputFrame.current !== undefined) window.clearTimeout(terminalOutputFrame.current);
    flushTerminalOutput();
  };
  const hide = () => setTerminalOpen(false);
  const close = () => { terminalPanelRevision.current += 1; hide(); };
  const reset = () => { hide(); setTerminalTarget(undefined); };
  const openFor = (target: TerminalTarget) => {
    terminalPanelRevision.current += 1;
    setTerminalTarget(target);
    setTerminalOpen(true);
  };
  const toggle = (target: TerminalTarget) => {
    terminalPanelRevision.current += 1;
    if (!terminalOpen()) setTerminalTarget(target);
    setTerminalOpen(open => !open);
  };
  const ids = (key: string) => terminalsBySession()[key]?.tabs.map(terminal => terminal.id) ?? [];
  const forget = (key: string) => {
    setTerminalsBySession(current => { const next = { ...current }; delete next[key]; return next; });
  };
  const rekeyStored = (previousKey: string, nextKey: string) => {
    setTerminalsBySession(current => {
      if (!(previousKey in current)) return current;
      const next = { ...current, [nextKey]: current[previousKey] };
      delete next[previousKey];
      return next;
    });
  };
  const rekey = (previousKey: string, nextKey: string, owner: NativeTransport) => {
    reassignTerminals(owner, terminalsBySession()[previousKey]?.tabs ?? [], nextKey, reason => addNotice({ title: "Could not move terminal history", message: String(reason) }));
    rekeyStored(previousKey, nextKey);
    setTerminalTarget(current => current?.sessionKey === previousKey ? { ...current, sessionKey: nextKey } : current);
  };
  const handleEvent = (event: RpcEvent) => {
    if (event.type === "terminal_output") queueTerminalOutput(String(event.terminalId ?? ""), String(event.data ?? ""));
    if (event.type === "terminal_exit") {
      setTerminalsBySession(current => Object.fromEntries(Object.entries(current).map(([key, session]) => [key, {
        ...session, tabs: session.tabs.map(terminal => terminal.id === event.terminalId ? { ...terminal, exited: true } : terminal),
      }])));
    }
  };
  const write = (data: string) => {
    const id = activeTerminal().id;
    void transport().writeTerminal(id, data).catch(reason => queueTerminalOutput(id, `\r\nTerminal input failed: ${String(reason)}\r\n`));
  };
  const resize = (cols: number, rows: number) => { void transport().resizeTerminal(activeTerminal().id, cols, rows).catch(() => undefined); };
  const shutdown = () => {
    for (const session of Object.values(terminalsBySession())) {
      for (const terminal of session.tabs) void transport().closeTerminal(terminal.id).catch(() => undefined);
    }
  };
  createDependencyEffect(() => {
    window.addEventListener("pagehide", shutdown);
    return () => window.removeEventListener("pagehide", shutdown);
  }, () => []);
  onCleanup(() => { flush(); shutdown(); });
  return {
    terminalOpen, terminalSessionId, terminalLocationState, sessionTerminals, activeTerminal, viewKey,
    hide, close, reset, openFor, toggle, ids, forget, rekeyStored, rekey, handleEvent, flush,
    startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal, write, resize,
  };
}
export type AppTerminals = ReturnType<typeof createAppTerminals>;
