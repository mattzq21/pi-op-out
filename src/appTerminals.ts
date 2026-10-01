import { createComputed, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { appendTerminalOutputs, initialTerminals, MAX_TERMINALS, terminalConversationKey, type QueuedTerminalOutput, type SessionTerminals, type TerminalTarget } from "./appSupport";
import { reassignTerminals } from "./appRuntime";
import type { NativeTransport } from "./lib/nativeTransport";
import { createMemoFields, createRef } from "./lib/solid";
import { appendTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import { nativeTerminals, type TerminalEvent } from "./lib/nativeTerminals";

type TerminalContext = {
  transport: Accessor<NativeTransport>;
  conversationKey: Accessor<string>;
  location: Accessor<{ cwd?: string; hostId: string }>;
  addNotice: (notice: { title: string; message: string }) => void;
};

export function createTerminalController({ transport, conversationKey, location, addNotice }: TerminalContext) {
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalTarget, setTerminalTarget] = createSignal<TerminalTarget>();
  const [terminalsBySession, setTerminalsBySession] = createSignal<Record<string, SessionTerminals>>({});
  const closingTerminals = createRef(new Set<string>());
  const startingTerminals = createRef(new Set<string>());
  const terminalPanelRevision = createRef(0);
  const terminalSessionId = createMemo(() => terminalConversationKey(terminalTarget(), conversationKey()));
  const terminalSessionIdRef = createRef(terminalSessionId());
  createComputed(() => { terminalSessionIdRef.current = terminalSessionId(); });

  const terminalLocationState = createMemo(() => ({
    terminalCwd: terminalTarget()?.cwd ?? location().cwd,
    terminalHostId: terminalTarget()?.hostId ?? location().hostId,
  }));

  const state = createMemoFields(() => {
    const sessionTerminals = terminalsBySession()[terminalSessionId()] ?? initialTerminals(terminalSessionId());
    const activeTerminal = sessionTerminals.tabs.find(terminal => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];

    return { sessionTerminals, activeTerminal };
  });

  const terminalState = () => state;
  const [readySession, setReadySession] = createSignal<string>();
  const ready = () => readySession() === terminalSessionId();
  let refreshShared = async () => {};
  createEffect(() => {
    const key = terminalSessionId();
    const hostId = terminalLocationState().terminalHostId;
    if (!terminalOpen()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let dirty = false;
    let buffered: TerminalEvent[] = [];
    let pending: Promise<void> | undefined;
    let reportedError = false;
    const refresh = () => {
      if (pending) { dirty = true; return pending; }
      pending = nativeTerminals.list(key, hostId).then(tabs => {
        if (cancelled) return;
        setTerminalsBySession(current => {
          const previous = current[key];
          const merged: SessionTerminals["tabs"] = tabs.map(tab => {
            queuedTerminalOutput.current.delete(tab.id);
            const old = previous?.tabs.find(value => value.id === tab.id && value.generation === tab.generation);
            return { ...old, ...tab };
          });
          for (const tab of previous?.tabs ?? []) {
            if (!tab.generation && !merged.some(value => value.id === tab.id) && (!tab.started || startingTerminals.current.has(tab.id))) merged.push(tab);
          }
          if (!merged.length) {
            if (previous?.tabs.some(tab => tab.generation)) setTerminalOpen(false);
            return { ...current, [key]: initialTerminals(key) };
          }
          return { ...current, [key]: { activeId: merged.some(tab => tab.id === previous?.activeId) ? previous!.activeId : merged[0].id, tabs: merged } };
        });
        setReadySession(key);
        reportedError = false;
      }).catch(reason => {
        if (!cancelled) {
          setReadySession(undefined);
          if (!reportedError) addNotice({ title: "Could not sync terminals", message: String(reason) });
          reportedError = true;
        }
      }).finally(() => {
        pending = undefined;
        if (cancelled) return;
        const events = buffered; buffered = [];
        for (const event of events) handleEvent(event);
        if (dirty) { dirty = false; void refresh(); }
      });
      return pending;
    };
    refreshShared = async () => { await pending; if (!cancelled) await refresh(); };
    const handleEvent = (event: TerminalEvent) => {
      if (cancelled || (event.hostId ?? "local") !== hostId || event.sessionId !== key.slice(key.lastIndexOf(":") + 1)) return;
      if (event.type === "terminal_changed") { void refresh(); return; }
      if (pending) {
        if (buffered.length < 512) buffered.push(event); else dirty = true;
        return;
      }
      let resync = false;
      setTerminalsBySession(current => {
        const session = current[key];
        const tab = session?.tabs.find(value => value.id === event.terminalId);
        if (!tab || tab.generation !== event.generation) { resync = true; return current; }
        if (event.type === "terminal_exit") {
          return { ...current, [key]: { ...session, tabs: session.tabs.map(value => value.id === tab.id ? { ...value, exited: true } : value) } };
        }
        if (event.type !== "terminal_output" || event.outputEnd === undefined || event.data === undefined || event.outputEnd <= tab.outputEnd) return current;
        const start = event.outputEnd - event.data.length;
        if (start > tab.outputEnd) { resync = true; return current; }
        const data = event.data.slice(tab.outputEnd - start);
        return { ...current, [key]: { ...session, tabs: session.tabs.map(value => value.id === tab.id ? { ...value, ...appendTerminalOutput(value.output, value.outputEnd, data, data.length) } : value) } };
      });
      if (resync) void refresh();
    };
    void nativeTerminals.listen(handleEvent).then(stop => {
      if (cancelled) { stop(); return; }
      unlisten = stop;
      void refresh();
    }).catch(reason => { if (!cancelled) addNotice({ title: "Could not subscribe to terminals", message: String(reason) }); });
    onCleanup(() => { cancelled = true; unlisten?.(); buffered = []; setReadySession(undefined); });
  });
  const takeOwnership = async () => {
    try { await nativeTerminals.claim(state.activeTerminal.id); await refreshShared(); }
    catch (reason) { addNotice({ title: "Could not take terminal ownership", message: String(reason) }); }
  };
  const queuedTerminalOutput = createRef(new Map<string, QueuedTerminalOutput>());
  const terminalOutputFrame = createRef<number | undefined>(undefined);

  const flushTerminalOutput = () => {
    terminalOutputFrame.current = undefined; const chunks = queuedTerminalOutput.current; queuedTerminalOutput.current = new Map();

    if (chunks.size) setTerminalsBySession((current) => appendTerminalOutputs(current, chunks));
  };

  const queueTerminalOutput = (terminalId: string, data: string) => {
    if (Object.values(terminalsBySession()).some(session => session.tabs.some(tab => tab.id === terminalId && tab.generation))) return;
    const queued = queuedTerminalOutput.current.get(terminalId); const combined = `${queued?.data ?? ""}${data}`;
    queuedTerminalOutput.current.set(terminalId, { data: combined.slice(-TERMINAL_OUTPUT_LIMIT), length: (queued?.length ?? 0) + data.length });

    if (terminalOutputFrame.current === undefined) terminalOutputFrame.current = window.setTimeout(flushTerminalOutput, 16);
  };

  const startTerminal = async (terminalId: string, cols: number, rows: number) => { const capturedTerminalSessionId = terminalSessionId(); const capturedTerminalLocationState = { ...terminalLocationState() }; const capturedTransport = transport();

    if (startingTerminals.current.has(terminalId)) return; startingTerminals.current.add(terminalId);
    const sessionKey = capturedTerminalSessionId;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

    return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = capturedTerminalLocationState.terminalCwd;

    if (!cwd) { startingTerminals.current.delete(terminalId); setTerminalsBySession((current) => { const session = current[sessionKey];

    return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n");

    return; }

    try { await capturedTransport.startTerminal(terminalId, sessionKey, cwd, cols, rows, capturedTerminalLocationState.terminalHostId); await refreshShared(); } catch (reason) { setTerminalsBySession((current) => { const session = current[sessionKey];

    return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${String(reason)}\r\n`); } finally { startingTerminals.current.delete(terminalId); }
  };

  const addTerminal = () => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

  if (session.tabs.length >= MAX_TERMINALS) return current; const id = `shared-terminal-${sessionKey}-${crypto.randomUUID()}`;

  return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };

  const selectTerminal = (terminalId: string) => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

  return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };

  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number, generation?: string) => { setTerminalsBySession((current) => { const session = current[sessionKey];

  if (!session?.tabs.some((terminal) => terminal.id === terminalId && terminal.generation === generation)) return current;

  return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };

  const deleteTerminal = async () => { const capturedComposerState = { ...terminalState() }; const capturedTerminalSessionId = terminalSessionId(); const capturedTransport = transport();
    const terminalId = capturedComposerState.activeTerminal.id; const closingLast = capturedComposerState.sessionTerminals.tabs.length === 1; const panelTarget = capturedTerminalSessionId; const panelRevision = terminalPanelRevision.current;

    if (closingTerminals.current.has(terminalId)) return; closingTerminals.current.add(terminalId);

    try { await capturedTransport.closeTerminal(terminalId); } catch (reason) { addNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) });

    return; }
    finally { closingTerminals.current.delete(terminalId); }

    if (closingLast && terminalSessionIdRef.current === panelTarget && terminalPanelRevision.current === panelRevision) setTerminalOpen(false);
    const sessionKey = panelTarget;
    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey); const removedIndex = session.tabs.findIndex((terminal) => terminal.id === terminalId); const tabs = session.tabs.filter((terminal) => terminal.id !== terminalId); const next = { ...current };

    if (!tabs.length) delete next[sessionKey]; else next[sessionKey] = { activeId: session.activeId !== terminalId && tabs.some((tab) => tab.id === session.activeId) ? session.activeId : tabs[Math.min(Math.max(0, removedIndex), tabs.length - 1)].id, tabs };

    return next; });
  };

  const flushOutput = () => {
    if (terminalOutputFrame.current !== undefined) window.clearTimeout(terminalOutputFrame.current);
    flushTerminalOutput();
  };

  onCleanup(flushOutput);
  const conversationTerminalIds = (key: string) => terminalsBySession()[key]?.tabs.map(terminal => terminal.id) ?? [];
  const allTerminalIds = () => Object.values(terminalsBySession()).flatMap(session => session.tabs.map(terminal => terminal.id));
  const draftTerminalIds = () => Object.entries(terminalsBySession()).filter(([key]) => key.slice(key.lastIndexOf(":") + 1).startsWith("draft-")).flatMap(([, session]) => session.tabs.map(terminal => terminal.id));

  const forgetConversation = (key: string) => setTerminalsBySession(current => {
    if (!(key in current)) return current;
    const next = { ...current }; delete next[key];

    return next;
  });

  const removeConversationTerminals = (key: string) => {
    forgetConversation(key);

    if (key === terminalSessionIdRef.current) setTerminalOpen(false);
  };

  const resetConversation = (key: string) => {
    forgetConversation(key);
    setTerminalTarget(current => current?.sessionKey === key ? undefined : current);
  };

  const rekeyConversation = (previousKey: string, nextKey: string, owner: NativeTransport) => {
    if (previousKey === nextKey) return;
    reassignTerminals(owner, terminalsBySession()[previousKey]?.tabs ?? [], nextKey, reason => addNotice({ title: "Could not move terminal history", message: String(reason) }));
    setTerminalsBySession(current => {
      if (!(previousKey in current)) return current;
      const next = { ...current, [nextKey]: current[previousKey] }; delete next[previousKey];

      return next;
    });
    setTerminalTarget(current => current?.sessionKey === previousKey ? { ...current, sessionKey: nextKey } : current);
  };

  const exited = (terminalId: string) => {
    flushOutput();
    setTerminalsBySession(current => Object.fromEntries(Object.entries(current).map(([key, session]) => [key, {
      ...session, tabs: session.tabs.map(terminal => terminal.id === terminalId ? { ...terminal, exited: true } : terminal),
    }])));
  };

  const toggleFor = (target: TerminalTarget) => {
    const close = terminalOpen() && terminalSessionId() === target.sessionKey;
    terminalPanelRevision.current += 1;
    setTerminalTarget(target); setTerminalOpen(!close);
  };

  const toggle = (target: () => TerminalTarget) => {
    terminalPanelRevision.current += 1;

    if (!terminalOpen()) setTerminalTarget(target());
    setTerminalOpen(open => !open);
  };

  const close = () => { terminalPanelRevision.current += 1; setTerminalOpen(false); };

  const write = (data: string) => {
    if (!ready() || state.activeTerminal.owned === false) return;
    const id = state.activeTerminal.id;
    void transport().writeTerminal(id, data).catch(reason => { addNotice({ title: "Terminal input failed", message: String(reason) }); void refreshShared(); });
  };

  const resize = (cols: number, rows: number) => { if (ready() && state.activeTerminal.owned !== false) void transport().resizeTerminal(state.activeTerminal.id, cols, rows).catch(() => undefined); };

  return {
    terminalOpen, setTerminalOpen, setTerminalTarget, terminalSessionId, terminalLocationState, state, ready, takeOwnership,
    viewKey: createMemo(() => `${terminalSessionId()}:${state.activeTerminal.id}:${state.activeTerminal.generation ?? ""}`),
    startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal,
    queueTerminalOutput, flushOutput, exited, conversationTerminalIds, allTerminalIds, draftTerminalIds,
    forgetConversation, removeConversationTerminals, resetConversation, rekeyConversation,
    toggleFor, toggle, close, write, resize,
  };
}
