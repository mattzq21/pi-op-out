import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { SidepaneOpening } from "../plugins/types";
import type { SessionSummary } from "../types";
import type { SubagentTarget } from "./subagentNavigation";
import { required } from "./required";

export interface SidepaneTab { key: string; kind: string; session: SessionSummary; label: string; running: boolean }

const sessionKey = (session: Pick<SessionSummary, "hostId" | "id">) => `${session.hostId ?? "local"}:${session.id}`;

const createdOrder = (left: SessionSummary, right: SessionSummary) => (left.path.split("/").at(-1) ?? "").localeCompare(right.path.split("/").at(-1) ?? "");

function tabLabel(session: SessionSummary) {
  return session.auxiliaryKind === "subagent" ? session.name.replace(/^Subagent: /, "") : session.name;
}

export interface SubagentTabStore { load(): string[]; save(keys: string[]): void }

const SUBAGENT_TABS_KEY = "piop-sidepane-subagent-tabs";

export const localSubagentTabs: SubagentTabStore = {
  load() {
    const saved: unknown = JSON.parse(localStorage.getItem(SUBAGENT_TABS_KEY) ?? "[]");

    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
  },
  save(keys) { localStorage.setItem(SUBAGENT_TABS_KEY, JSON.stringify(keys)); },
};

interface Options {
  sessions: Accessor<SessionSummary[]>;
  main: Accessor<{ hostId: string; sessionId?: string }>;
  running: (session: SessionSummary) => boolean;
  subagentTabs: SubagentTabStore;
  onError: (message: string) => void;
}

export function createSidepaneTabs(options: Options) {
  const [open, setOpen] = createSignal(false);
  const [selectedKey, setSelectedKey] = createSignal<string>();
  const [opened, setOpened] = createSignal<SessionSummary[]>([]);
  const [pinned, setPinned] = createSignal<ReadonlySet<string>>((() => {
    try { return new Set(options.subagentTabs.load()); }
    catch (error) { options.onError(`Could not read the saved subagent tabs: ${error instanceof Error ? error.message : String(error)}`); return new Set<string>(); }
  })());
  createEffect(on(pinned, keys => {
    try { options.subagentTabs.save([...keys]); }
    catch (error) { options.onError(`Could not save the subagent tabs: ${error instanceof Error ? error.message : String(error)}`); }
  }, { defer: true }));
  const openings = new Map<string, SidepaneOpening>();
  const change = (update: (current: Set<string>) => void) => (current: ReadonlySet<string>) => { const next = new Set(current); update(next); return next; };

  const auxiliaryTree = createMemo(() => {
    const main = options.main();

    if (!main.sessionId) return [];
    const listed = options.sessions();
    const known = new Map([...opened(), ...listed].map(session => [sessionKey(session), session]));
    const children = new Map<string, SessionSummary[]>();

    for (const session of known.values()) {
      if (!session.auxiliaryParentId || !session.auxiliaryKind) continue;
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

  createEffect(on(() => options.sessions().filter(session => session.auxiliaryKind === "subagent" && options.running(session)).map(sessionKey), (running, previous = []) => {
    const started = running.filter(key => !previous.includes(key));

    if (!started.length) return;
    setPinned(change(next => { for (const key of started) next.add(key); }));
  }));

  const agents = createMemo<SidepaneTab[]>(() => auxiliaryTree()
    .map(session => ({ key: sessionKey(session), kind: required(session.auxiliaryKind), session, label: tabLabel(session), running: options.running(session) })));
  const tabs = createMemo<SidepaneTab[]>(() => agents().filter(tab => tab.kind !== "subagent" || pinned().has(tab.key)));

  const selected = createMemo(() => tabs().find(tab => tab.key === selectedKey()) ?? tabs()[0]);
  const shown = () => open() && tabs().length > 0;
  const show = (key: string) => { setSelectedKey(key); setOpen(true); };

  createEffect(on(() => options.sessions().map(sessionKey).join("\n"), () => {
    const listed = new Set(options.sessions().map(sessionKey));
    setOpened(current => current.some(session => listed.has(sessionKey(session))) ? current.filter(session => !listed.has(sessionKey(session))) : current);
  }));

  const openAuxiliary = (session: SessionSummary, opening?: SidepaneOpening) => {
    const key = sessionKey(session);

    if (opening) openings.set(key, opening);

    if (!options.sessions().some(item => sessionKey(item) === key)) setOpened(current => [...current.filter(item => sessionKey(item) !== key), session]);

    if (session.auxiliaryKind === "subagent") setPinned(change(next => next.add(key)));
    show(key);
  };

  return {
    agents, tabs, selected, open, setOpen, shown, openAuxiliary,
    workingTree: (session: SessionSummary) => {
      const host = session.hostId ?? "local";
      const tree = [session.id];

      for (let index = 0; index < tree.length; index++) for (const child of options.sessions()) {
        if ((child.hostId ?? "local") === host && child.auxiliaryParentId === tree[index] && !tree.includes(child.id)) tree.push(child.id);
      }

      return options.sessions().some(item => (item.hostId ?? "local") === host && tree.includes(item.id) && options.running(item)) || options.running(session);
    },
    working: createMemo(() => tabs().some(tab => tab.running)),
    select: setSelectedKey,
    openSubagent: (target: SubagentTarget) => {
      const listed = options.sessions().find(session => session.id === target.sessionId && (session.hostId ?? "local") === target.hostId);
      const main = options.main();
      const session = listed ?? { id: target.sessionId, path: target.sessionPath, hostId: target.hostId, name: target.name, project: "", cwd: "", preview: "", messageCount: 0, lastMessageAt: 0, apiCost: 0, auxiliaryKind: "subagent", auxiliaryParentId: main.sessionId };

      openAuxiliary(session);
    },
    opening: (key: string) => openings.get(key),
    finishOpening: (key: string) => { openings.delete(key); },
    forget: (key: string) => {
      openings.delete(key);
      setOpened(current => current.filter(session => sessionKey(session) !== key));
      setPinned(change(next => next.delete(key)));
    },
    forgetRemoved: (hostId: string, sessionId: string | undefined, sessionPath: string | undefined) => {
      const matches = (session: SessionSummary) => (session.hostId ?? "local") === hostId && (session.id === sessionId || Boolean(sessionPath && session.path === sessionPath));
      const keys = [...opened(), ...options.sessions()].filter(matches).map(sessionKey);

      if (sessionId) keys.push(`${hostId}:${sessionId}`);
      for (const key of new Set(keys)) {
        openings.delete(key);
        setPinned(change(next => next.delete(key)));
      }
      setOpened(current => current.filter(session => !matches(session)));
    },
  };
}

export type SidepaneTabs = ReturnType<typeof createSidepaneTabs>;
