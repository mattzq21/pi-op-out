import { createComputed, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { appendTerminalOutputs, initialTerminals, MAX_TERMINALS, terminalConversationKey, type QueuedTerminalOutput, type SessionTerminals, type TerminalTarget } from "./appSupport";
import { reassignTerminals } from "./appRuntime";
import type { NativeTransport } from "./lib/nativeTransport";
import { createDependencyEffect, createMemoFields, createRef } from "./lib/solid";
import { isMobile, listen } from "./lib/platform";
import { z } from "zod";
import { appendTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "./lib/terminalOutput";
import { nativeTerminals, TRANSCRIPT_BYTE_LIMIT, type SharedTerminal, type TerminalEvent } from "./lib/nativeTerminals";

function appendSharedTerminalEvent(session: SessionTerminals, tab: SessionTerminals["tabs"][number], event: TerminalEvent): SessionTerminals | "resync" {
  if (event.type !== "terminal_output" || event.outputEnd === undefined || event.data === undefined || event.outputEnd <= tab.outputEnd) return session;
  const start = event.outputEnd - event.data.length;

  if (start > tab.outputEnd) return "resync";
  const data = event.data.slice(tab.outputEnd - start);

  return { ...session, tabs: session.tabs.map(value => value.id === tab.id ? { ...value, ...appendTerminalOutput(value.output, value.outputEnd, data, data.length) } : value) };
}

type TerminalContext = {
  transport: Accessor<NativeTransport>;
  sessionTransport: (key: string) => NativeTransport | undefined;
  conversationKey: Accessor<string>;
  location: Accessor<{ cwd?: string; hostId: string }>;
  addNotice: (notice: { title: string; message: string }) => (() => void) | void;
};

export function createTerminalController({ transport, sessionTransport, conversationKey, location, addNotice }: TerminalContext) {
  let restarting = false;

  const restartListener = listen("pi://daemon-restarting", ({ payload }) => {
    nativeTerminals.invalidateWrites(payload.hostId ?? "local");
    if (!payload.hostId || payload.hostId === "local" || payload.hostId === location().hostId) restarting = true;
  }, z.object({ hostId: z.string().optional() }).passthrough());

  const reconnectListener = listen("pi://event", ({ payload }) => {
    if (payload.type === "disconnected" || payload.type === "connection_restored") nativeTerminals.invalidateWrites(payload.hostId);
    if (payload.type === "connection_restored") restarting = false;
  }, z.object({ type: z.string().optional(), hostId: z.string().optional() }).passthrough());

  onCleanup(() => { void restartListener.then(stop => stop()); void reconnectListener.then(stop => stop()); });

  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalTarget, setTerminalTarget] = createSignal<TerminalTarget>();
  const [terminalsBySession, storeTerminalsBySession] = createSignal<Record<string, SessionTerminals>>({});
  const closingTerminals = createRef(new Set<string>());
  const startingTerminals = createRef(new Set<string>());
  const draftRevisions = new Map<string, { data: string }>();
  const terminalPanelRevision = createRef(0);
  const terminalSessionId = createMemo(() => terminalConversationKey(terminalTarget(), conversationKey()));
  const terminalSessionIdRef = createRef(terminalSessionId());
  createComputed(() => { terminalSessionIdRef.current = terminalSessionId(); });
  const recentSessions = new Map<string, number>();
  let terminalAccess = 0;
  const trimTerminalHistory = (sessions: Record<string, SessionTerminals>) => {
    const active = terminalSessionIdRef.current;
    const sizes = Object.entries(sessions).map(([key, session]) => ({ key, bytes: session.tabs.reduce((total, tab) => total + (tab.output.length + (tab.snapshot?.length ?? 0)) * 2, 0) }));
    let bytes = sizes.reduce((total, value) => total + value.bytes, 0);
    let next = sessions;

    for (const key of recentSessions.keys()) if (key !== active && !(key in sessions)) recentSessions.delete(key);
    for (const value of sizes.sort((left, right) => (recentSessions.get(left.key) ?? 0) - (recentSessions.get(right.key) ?? 0))) {
      if (bytes <= TRANSCRIPT_BYTE_LIMIT) break;
      if (value.key === active || !value.bytes) continue;
      if (next === sessions) next = { ...sessions };
      next[value.key] = { ...sessions[value.key], tabs: sessions[value.key].tabs.map(tab => ({ ...tab, output: "", outputEnd: 0, snapshot: undefined, snapshotEnd: undefined })) };
      bytes -= value.bytes;
    }

    return next;
  };
  const setTerminalsBySession = (update: (current: Record<string, SessionTerminals>) => Record<string, SessionTerminals>) => storeTerminalsBySession(current => trimTerminalHistory(update(current)));
  createComputed(() => {
    recentSessions.set(terminalSessionId(), ++terminalAccess);
    untrack(() => setTerminalsBySession(current => current));
  });
  const [prepareTerminal, setPrepareTerminal] = createSignal(true);
  createDependencyEffect(() => { setPrepareTerminal(true); }, () => [terminalSessionId()]);
  createEffect(() => { if (terminalOpen()) setPrepareTerminal(true); });

  const terminalLocationState = createMemo(() => ({
    terminalCwd: terminalTarget()?.cwd ?? location().cwd,
    terminalHostId: terminalTarget()?.hostId ?? location().hostId,
  }), undefined, { equals: (previous, next) => previous.terminalCwd === next.terminalCwd && previous.terminalHostId === next.terminalHostId });

  createEffect(() => {
    if (!terminalOpen()) return;
    const { terminalCwd, terminalHostId } = terminalLocationState();
    sessionTransport(terminalSessionId())?.markTerminalActivity(terminalCwd, terminalHostId);
  });

  const state = createMemoFields(() => {
    const sessionTerminals = terminalsBySession()[terminalSessionId()] ?? initialTerminals(terminalSessionId());
    const activeTerminal = sessionTerminals.tabs.find(terminal => terminal.id === sessionTerminals.activeId) ?? sessionTerminals.tabs[0];

    return { sessionTerminals, activeTerminal };
  });

  const terminalState = () => state;
  const [owned, setOwned] = createSignal(false);
  const [chatStarted, setChatStarted] = createSignal(false);
  createEffect(() => {
    const owner = sessionTransport(terminalSessionId());
    setChatStarted(owner?.hasSentMessage() ?? false);
    setOwned(Boolean(owner?.hasConfirmedOwnership() && owner.hasSentMessage()));

    const stop = owner?.subscribe(event => {
      if (event.type === "ownership_acquired" || event.type === "ownership_lost" || event.type === "disconnected" || event.type === "message_start" || event.type === "agent_start") {
        setChatStarted(owner.hasSentMessage());
        setOwned(owner.hasConfirmedOwnership() && owner.hasSentMessage());
        void refreshShared();
      }
    });

    onCleanup(() => stop?.());
  });
  const [readySession, setReadySession] = createSignal<string>();
  const ready = () => chatStarted() && readySession() === terminalSessionId();
  let refreshShared = async () => {};

  createEffect(() => {
    const key = terminalSessionId();
    const hostId = terminalLocationState().terminalHostId;

    if (!terminalLocationState().terminalCwd || !chatStarted()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let dirty = false;
    let buffered: TerminalEvent[] = [];
    let pending: Promise<void> | undefined;
    let reportedError = false;
    let dismissError: (() => void) | undefined;
    let synchronized = false;

    const mergeSharedTabs = (tabs: SharedTerminal[], previous?: SessionTerminals) => {
      const merged: SessionTerminals["tabs"] = tabs.map(tab => {
        queuedTerminalOutput.current.delete(tab.id);
        const old = previous?.tabs.find(value => value.id === tab.id && value.generation === tab.generation);

        return old && old.outputEnd > tab.outputEnd
          ? { ...old, ...tab, output: old.output, outputEnd: old.outputEnd }
          : { ...old, ...tab };
      });

      for (const tab of previous?.tabs ?? []) {
        if (!tab.placeholder && !tab.generation && !merged.some(value => value.id === tab.id) && (!tab.started || startingTerminals.current.has(tab.id))) merged.push(tab);
      }

      return merged;
    };

    const refresh = () => {
      if (pending) { dirty = true;

        return pending; }

      pending = nativeTerminals.list(key, hostId).then(tabs => {
        if (cancelled) return;
        setTerminalsBySession(current => {
          const previous = current[key];

          const merged = mergeSharedTabs(tabs, previous);

          if (!merged.length) {
            if (synchronized && previous?.tabs.some(tab => tab.generation)) { setPrepareTerminal(false); setTerminalOpen(false); }

            return { ...current, [key]: initialTerminals(key) };
          }

          return { ...current, [key]: { activeId: merged.find(tab => tab.id === previous?.activeId)?.id ?? merged[0].id, tabs: merged } };
        });
        synchronized = true;
        setReadySession(key);
        dismissError?.();
        dismissError = undefined;
        reportedError = false;
      }).catch(reason => {
        if (!cancelled) {
          setReadySession(undefined);

          if (!reportedError && !restarting) {
            const dismiss = addNotice({ title: "Could not sync terminals", message: reason instanceof Error ? reason.message : String(reason) });

            if (dismiss) dismissError = dismiss;
          }

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

    refreshShared = async () => { await pending;

      if (!cancelled) await refresh(); };

    const handleEvent = (event: TerminalEvent) => {
      if (cancelled || (event.hostId ?? "local") !== hostId || event.sessionId !== key.slice(key.lastIndexOf(":") + 1)) return;

      if (event.type === "terminal_changed") { void refresh();

        return; }

      if (pending) {
        if (buffered.length < 512) buffered.push(event); else dirty = true;

        return;
      }

      let resync = false;
      setTerminalsBySession(current => {
        const session = current[key];
        const tab = session?.tabs.find(value => value.id === event.terminalId);

        if (!tab || tab.generation !== event.generation) { resync = true;

          return current; }

        if (event.type === "terminal_draft") {
          return { ...current, [key]: { ...session, tabs: session.tabs.map(value => value.id === tab.id ? { ...value, inputDraft: event.data ?? "" } : value) } };
        }

        if (event.type === "terminal_exit") {
          return { ...current, [key]: { ...session, tabs: session.tabs.map(value => value.id === tab.id ? { ...value, exited: true } : value) } };
        }

        const updated = appendSharedTerminalEvent(session, tab, event);

        if (updated === "resync") { resync = true;

          return current; }

        return updated === session ? current : { ...current, [key]: updated };
      });

      if (resync) void refresh();
    };

    void nativeTerminals.listen(handleEvent).then(stop => {
      if (cancelled) { stop();

        return; }

      unlisten = stop;
      void refresh();
    }).catch(reason => { if (!cancelled) addNotice({ title: "Could not subscribe to terminals", message: reason instanceof Error ? reason.message : String(reason) }); });
    onCleanup(() => { cancelled = true; unlisten?.(); dismissError?.(); buffered = []; setReadySession(undefined); });
  });

  const takeOwnership = async () => {
    try { const owner = sessionTransport(terminalSessionId());

      if (!owner) throw new Error("Session is unavailable"); await owner.takeOwnership(); setOwned(owner.hasConfirmedOwnership() && owner.hasSentMessage()); await refreshShared(); }
    catch (reason) { addNotice({ title: "Could not take session ownership", message: reason instanceof Error ? reason.message : String(reason) }); }
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

  const preparePlaceholder = async (terminalId: string, sessionKey: string, owner: NativeTransport) => {
    if (!state.activeTerminal.placeholder) return true;
    await refreshShared();
    const tab = terminalsBySession()[sessionKey]?.tabs.find(value => value.id === terminalId);

    return owned() && owner.hasConfirmedOwnership() && ready() && terminalSessionId() === sessionKey && Boolean(tab?.placeholder);
  };

  const startTerminal = async (terminalId: string, cols: number, rows: number) => { const capturedTerminalSessionId = terminalSessionId(); const capturedTerminalLocationState = { ...terminalLocationState() }; const capturedTransport = sessionTransport(capturedTerminalSessionId) ?? transport(); const preparation = !terminalOpen();

    if (!owned() || !capturedTransport.hasConfirmedOwnership() || startingTerminals.current.has(terminalId)) return; startingTerminals.current.add(terminalId);
    const sessionKey = capturedTerminalSessionId;

    if (!await preparePlaceholder(terminalId, sessionKey, capturedTransport) || !terminalOpen()) {
      startingTerminals.current.delete(terminalId);

      return;
    }

    setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

    return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: true, exited: false } : terminal) } }; });
    const cwd = capturedTerminalLocationState.terminalCwd;

    if (!cwd) { startingTerminals.current.delete(terminalId); setTerminalsBySession((current) => { const session = current[sessionKey];

    return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); addNotice({ title: "Could not start terminal", message: "Could not determine this session's working directory." }); queueTerminalOutput(terminalId, "\r\nCould not determine this session's working directory.\r\n");

    return; }

    try { await capturedTransport.startTerminal(terminalId, sessionKey, cwd, cols, rows, capturedTerminalLocationState.terminalHostId, preparation); await refreshShared(); } catch (reason) { setTerminalsBySession((current) => { const session = current[sessionKey];

    return session ? { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, started: false, exited: true } : terminal) } } : current; }); addNotice({ title: "Could not start terminal", message: reason instanceof Error ? reason.message : String(reason) }); queueTerminalOutput(terminalId, `\r\nCould not start terminal: ${(reason instanceof Error ? reason.message : String(reason))}\r\n`); } finally { startingTerminals.current.delete(terminalId); }
  };

  const addTerminal = () => { if (!owned()) return; const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

  if (session.tabs.length >= MAX_TERMINALS) return current; const id = `shared-terminal-${sessionKey}-${crypto.randomUUID()}`;

  return { ...current, [sessionKey]: { activeId: id, tabs: [...session.tabs, { id, output: "", outputEnd: 0, started: false }] } }; }); };

  const selectTerminal = (terminalId: string) => { const sessionKey = terminalSessionId(); setTerminalsBySession((current) => { const session = current[sessionKey] ?? initialTerminals(sessionKey);

  return { ...current, [sessionKey]: { ...session, activeId: terminalId } }; }); };

  const saveTerminalSnapshot = (sessionKey: string, terminalId: string, snapshot: string, snapshotEnd: number, generation?: string) => { setTerminalsBySession((current) => { const session = current[sessionKey];

  if (!session?.tabs.some((terminal) => terminal.id === terminalId && terminal.generation === generation)) return current;

  return { ...current, [sessionKey]: { ...session, tabs: session.tabs.map((terminal) => terminal.id === terminalId ? { ...terminal, snapshot, snapshotEnd } : terminal) } }; }); };

  const deleteTerminal = async () => { if (!owned()) return; const capturedComposerState = { ...terminalState() }; const capturedTerminalSessionId = terminalSessionId(); const capturedTransport = transport();
    const terminalId = capturedComposerState.activeTerminal.id; const closingLast = capturedComposerState.sessionTerminals.tabs.length === 1; const panelTarget = capturedTerminalSessionId; const panelRevision = terminalPanelRevision.current;

    if (closingTerminals.current.has(terminalId)) return; closingTerminals.current.add(terminalId);

    try { await capturedTransport.closeTerminal(terminalId); } catch (reason) { addNotice({ title: "Could not close terminal", message: reason instanceof Error ? reason.message : String(reason) });

    return; }
    finally { closingTerminals.current.delete(terminalId); }

    draftRevisions.delete(terminalId);

    if (closingLast && terminalSessionIdRef.current === panelTarget && terminalPanelRevision.current === panelRevision) { setPrepareTerminal(false); setTerminalOpen(false); }

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
  const conversationTerminalIds = (key: string) => terminalsBySession()[key]?.tabs.filter(terminal => !terminal.placeholder || terminal.started).map(terminal => terminal.id) ?? [];
  const allTerminalIds = () => Object.values(terminalsBySession()).flatMap(session => session.tabs.map(terminal => terminal.id));
  const draftTerminalIds = () => Object.entries(terminalsBySession()).filter(([key]) => key.slice(key.lastIndexOf(":") + 1).startsWith("draft-")).flatMap(([, session]) => session.tabs.map(terminal => terminal.id));

  const forgetConversation = (key: string) => setTerminalsBySession(current => {
    if (!(key in current)) return current;

    for (const tab of current[key].tabs) draftRevisions.delete(tab.id);
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
    reassignTerminals(owner, terminalsBySession()[previousKey]?.tabs ?? [], nextKey, reason => addNotice({ title: "Could not move terminal history", message: reason instanceof Error ? reason.message : String(reason) }));
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

  const chatStartedFor = (key: string) => sessionTransport(key)?.hasSentMessage() ?? false;

  const toggleFor = (target: TerminalTarget) => {
    if (!chatStartedFor(target.sessionKey)) return;
    const closing = terminalOpen() && terminalSessionId() === target.sessionKey;
    if (terminalOpen()) void close();
    terminalPanelRevision.current += 1;
    setTerminalTarget(target); setTerminalOpen(!closing);
  };

  const toggle = (target: () => TerminalTarget) => {
    if (terminalOpen()) { void close(); return; }
    const next = target();
    if (!chatStartedFor(next.sessionKey)) return;
    terminalPanelRevision.current += 1;
    setTerminalTarget(next);
    setTerminalOpen(true);
  };

  const close = async () => {
    const tabs = owned() ? state.sessionTerminals.tabs.filter(tab => tab.started || startingTerminals.current.has(tab.id)) : [];
    terminalPanelRevision.current += 1;
    setTerminalOpen(false);
    await Promise.all(tabs.map(async tab => {
      try { await nativeTerminals.closeUnused(tab.id); }
      catch (reason) { addNotice({ title: "Could not close unused terminal", message: reason instanceof Error ? reason.message : String(reason) }); }
    }));
    await refreshShared();
  };

  const syncDraft = (id: string, data: string) => {
    const revision = { data };
    draftRevisions.set(id, revision);
    void nativeTerminals.write(id, data, "draft").catch(reason => {
      // The host kept its older draft. Send must expect that draft; the unsent text stays in the input.
      if (draftRevisions.get(id) === revision) draftRevisions.delete(id);
      addNotice({ title: "Could not sync terminal input", message: reason instanceof Error ? reason.message : String(reason) });
    });
  };

  const clearAcceptedDraft = (key: string, id: string, generation: string | undefined, revision: { data: string } | undefined) => {
    const target = terminalsBySession()[key]?.tabs.find(tab => tab.id === id);

    if (!target || target.generation !== generation || !sessionTransport(key)?.hasConfirmedOwnership()) return;

    if (revision === draftRevisions.get(id)) draftRevisions.delete(id);
  };

  const write = async (data: string, clearDraft = false, userInput = true) => {
    if (!ready() || !owned()) return false;
    const { id, generation } = state.activeTerminal;
    const key = terminalSessionId();
    const revision = draftRevisions.get(id);

    try {
      if (!userInput) await nativeTerminals.write(id, data, "reply");
      else if (clearDraft && data === "\u0003") await nativeTerminals.interrupt(id);
      else if (clearDraft) await nativeTerminals.writeAndClearDraft(id, data, revision?.data ?? state.activeTerminal.inputDraft ?? "");
      else await transport().writeTerminal(id, data);
    }
    catch (reason) { addNotice({ title: "Terminal input failed", message: reason instanceof Error ? reason.message : String(reason) }); void refreshShared();

      return false; }

    if (clearDraft) clearAcceptedDraft(key, id, generation, revision);

    return true;
  };

  const updateDraft = (data: string) => {
    if (!ready() || !owned()) return;
    syncDraft(state.activeTerminal.id, data);
  };

  const resize = async (cols: number, rows: number) => {
    if (isMobile || !ready() || !owned()) return;

    try { await transport().resizeTerminal(state.activeTerminal.id, cols, rows); }
    catch (reason) {
      addNotice({ title: "Could not resize terminal", message: reason instanceof Error ? reason.message : String(reason) });
      throw reason;
    }
  };

  createDependencyEffect(() => {
    if (isMobile || !terminalOpen() || !ready() || !owned() || !state.activeTerminal.inputDraft) return;
    void nativeTerminals.write(state.activeTerminal.id, "", "adopt_draft").catch(reason => addNotice({ title: "Could not restore terminal input", message: reason instanceof Error ? reason.message : String(reason) }));
  }, () => [terminalOpen(), ready(), owned(), state.activeTerminal.id, state.activeTerminal.inputDraft]);

  return {
    terminalOpen, setTerminalOpen, setTerminalTarget, terminalSessionId, terminalLocationState, state, ready, prepareTerminal, owned, takeOwnership,
    viewKey: createMemo(() => `${terminalSessionId()}:${state.activeTerminal.id}:${state.activeTerminal.generation ?? ""}`),
    startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal,
    queueTerminalOutput, flushOutput, exited, conversationTerminalIds, allTerminalIds, draftTerminalIds,
    forgetConversation, removeConversationTerminals, resetConversation, rekeyConversation,
    toggleFor, toggle, close, write, updateDraft, resize,
  };
}
