import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { SidepaneOpening } from "../plugins/types";
import type { SessionSummary } from "../types";
import type { SubagentTarget } from "./subagentNavigation";

/** One tab of the side pane. kind is the auxiliary kind of the chat, or "chat" for a root chat that the user opened next to the main chat. */
export interface SidepaneTab { key: string; kind: string; session: SessionSummary; label: string; running: boolean }

const sessionKey = (session: Pick<SessionSummary, "hostId" | "id">) => `${session.hostId ?? "local"}:${session.id}`;

/** Transcript files start with their creation time, so their names sort oldest first. */
const createdOrder = (left: SessionSummary, right: SessionSummary) => (left.path.split("/").at(-1) ?? "").localeCompare(right.path.split("/").at(-1) ?? "");

function tabLabel(session: SessionSummary) {
  return session.auxiliaryKind === "subagent" ? session.name.replace(/^Subagent: /, "") : session.name;
}

interface Options {
  sessions: Accessor<SessionSummary[]>;
  /** The chat in the main pane. Its auxiliary chats are the tabs. */
  main: Accessor<{ hostId: string; sessionId?: string }>;
  running: (session: SessionSummary) => boolean;
}

/**
 * The side pane tabs: the btw, review and subagent chats in the main chat's tree, oldest first, and root chats the user opened
 * there. A subagent gets a tab while it works or after the user opens it, and keeps it until the user closes it.
 */
export function createSidepaneTabs(options: Options) {
  const [open, setOpen] = createSignal(false);
  const [selectedKey, setSelectedKey] = createSignal<string>();
  /** Auxiliary chats that a command opened before the session list has them. */
  const [opened, setOpened] = createSignal<SessionSummary[]>([]);
  const [chats, setChats] = createSignal<SessionSummary[]>([]);
  const [pinned, setPinned] = createSignal<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const openings = new Map<string, SidepaneOpening>();
  const change = (update: (current: Set<string>) => void) => (current: ReadonlySet<string>) => { const next = new Set(current); update(next); return next; };

  const auxiliaryTree = createMemo(() => {
    const main = options.main();

    if (!main.sessionId) return [];
    const listed = options.sessions();
    const known = new Map([...opened(), ...listed].map(session => [sessionKey(session), session]));
    const children = new Map<string, SessionSummary[]>();

    for (const session of known.values()) {
      if (!session.auxiliaryParentId) continue;
      const parent = `${session.hostId ?? "local"}:${session.auxiliaryParentId}`;
      children.set(parent, [...children.get(parent) ?? [], session]);
    }

    const tree: SessionSummary[] = [];
    const queue = [`${main.hostId}:${main.sessionId}`];

    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]) ?? []) {
      const key = sessionKey(child);

      if (queue.includes(key)) continue;
      queue.push(key); tree.push(child);
    }

    return tree.sort(createdOrder);
  });

  // A subagent that starts working gets its tab back.
  createEffect(on(() => auxiliaryTree().filter(session => session.auxiliaryKind === "subagent" && options.running(session)).map(sessionKey), (running, previous = []) => {
    const started = running.filter(key => !previous.includes(key));

    if (!started.length) return;
    setDismissed(change(next => { for (const key of started) next.delete(key); }));
    setPinned(change(next => { for (const key of started) next.add(key); }));
  }));

  const tabs = createMemo<SidepaneTab[]>(() => {
    const main = options.main();
    const auxiliary = auxiliaryTree().filter(session => session.auxiliaryKind !== "subagent" || pinned().has(sessionKey(session)) && !dismissed().has(sessionKey(session)));
    const roots = chats().filter(session => session.id !== main.sessionId || (session.hostId ?? "local") !== main.hostId);

    return [...auxiliary.map(session => ({ kind: session.auxiliaryKind ?? "chat", session })), ...roots.map(session => ({ kind: "chat", session }))]
      .map(({ kind, session }) => ({ key: sessionKey(session), kind, session, label: tabLabel(session), running: options.running(session) }));
  });

  const selected = createMemo(() => tabs().find(tab => tab.key === selectedKey()) ?? tabs()[0]);
  const shown = () => open() && tabs().length > 0;
  const show = (key: string) => { setSelectedKey(key); setOpen(true); };

  createEffect(on(() => options.sessions().map(sessionKey).join("\n"), () => {
    const listed = new Set(options.sessions().map(sessionKey));
    setOpened(current => current.some(session => listed.has(sessionKey(session))) ? current.filter(session => !listed.has(sessionKey(session))) : current);
  }));

  /** Opens an auxiliary chat. opening carries the first prompt of a chat that a command created, until the chat reports that it opened. */
  const openAuxiliary = (session: SessionSummary, opening?: SidepaneOpening) => {
    const key = sessionKey(session);

    if (opening) openings.set(key, opening);

    if (!options.sessions().some(item => sessionKey(item) === key)) setOpened(current => [...current.filter(item => sessionKey(item) !== key), session]);

    if (session.auxiliaryKind === "subagent") { setPinned(change(next => next.add(key))); setDismissed(change(next => next.delete(key))); }
    show(key);
  };

  return {
    tabs, selected, open, setOpen, shown, openAuxiliary,
    /** True when a chat in the tabs works. */
    working: createMemo(() => tabs().some(tab => tab.running)),
    select: setSelectedKey,
    /** Opens a root chat next to the main chat. */
    openChat: (session: SessionSummary) => {
      const key = sessionKey(session);
      setChats(current => [...current.filter(item => sessionKey(item) !== key), session]);
      show(key);
    },
    openSubagent: (target: SubagentTarget) => {
      const listed = options.sessions().find(session => session.id === target.sessionId && (session.hostId ?? "local") === target.hostId);
      const main = options.main();
      const session = listed ?? { id: target.sessionId, path: target.sessionPath, hostId: target.hostId, name: target.name, project: "", cwd: "", preview: "", messageCount: 0, lastMessageAt: 0, apiCost: 0, auxiliaryKind: "subagent", auxiliaryParentId: main.sessionId };

      openAuxiliary(session);
    },
    /** The first prompt of a tab that a command opened, until finishOpening. */
    opening: (key: string) => openings.get(key),
    finishOpening: (key: string) => { openings.delete(key); },
    /** Removes a root chat tab or hides a subagent tab. Auxiliary chats of other kinds leave the tabs when they are archived. */
    forget: (key: string) => {
      openings.delete(key);
      setChats(current => current.filter(session => sessionKey(session) !== key));
      setDismissed(change(next => next.add(key)));
      setPinned(change(next => next.delete(key)));
    },
    /** Replaces a root chat tab after a fork in it moved the pane to another chat. */
    replaceChat: (previousKey: string, session: SessionSummary) => {
      setChats(current => current.map(item => sessionKey(item) === previousKey ? session : item));
      if (selectedKey() === previousKey) setSelectedKey(sessionKey(session));
    },
  };
}

export type SidepaneTabs = ReturnType<typeof createSidepaneTabs>;
