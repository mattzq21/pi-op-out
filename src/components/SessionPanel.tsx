import { Key } from "@solid-primitives/keyed";
import { createComputed, createMemo, createSignal, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect, createMemoFields, createRef, cssPixels, type KeyboardEvent, type MouseEvent } from "../lib/solid";

import { AppWindow, Archive, ChevronDown, Columns2, CopyPlus, Ellipsis, Folder, FolderGit2, FolderOpen, GitBranch, MessageSquarePlus, Pencil, Search, Trash2 } from "lucide-solid";
import { hasVisibleText } from "../lib/content";
import { gitProjectKind, gitWorktreeRoots, openGroupDirectory } from "../lib/nativeTransport";
import { isTemporaryChatCwd, useSessionGroups, type SessionGroup } from "../lib/sessionGroups";
import type { SessionSummary } from "../types";
import { RemoveGroupDialog } from "./RemoveGroupDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";

export type SessionAction = "split" | "new-window" | "rename" | "clone" | "open-directory" | "archive";
interface Props { sessions: SessionSummary[]; activeId?: string; activeHostId?: string; runningSessions?: ReadonlySet<string>; unseenSessions?: ReadonlySet<string>; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onAction: (session: SessionSummary, action: SessionAction) => void; onNewChat: (group: SessionGroup) => void; onCreateWorktree: (cwd: string, hostId: string) => void; onDeleteWorktree: (cwd: string, hostId: string, deleteBranch: boolean) => Promise<void>; createGroupRequest?: number; onCreateGroupHandled?: () => void; }
type CustomGroup = SessionGroup;
interface DraggedSession { projectKey: string; sessionKey: string; session: SessionSummary; }
interface DropTarget { projectKey: string; sessionKey: string; edge: "before" | "after"; layoutBefore?: string | null; }
type DraggedItem = DraggedSession | { projectKey: string };
type MouseDrag = DraggedItem & { startX: number; startY: number; active: boolean; };

const actions = [
  ["split", Columns2, "Split pane"], ["new-window", AppWindow, "Open in new window"], ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["open-directory", FolderOpen, "Open project directory"]
] as const;
const COLLAPSED_PROJECTS_KEY = "pi-desktop-collapsed-projects";
const SESSION_ORDERS_KEY = "pi-desktop-session-orders";
const SIDEBAR_ORDER_KEY = "pi-desktop-sidebar-order";
const RECENT_KEY = "__pi-desktop-ungrouped__";
const RECENT_LABEL = "Recent";
const sidebarCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function projectKindLabel(session: SessionSummary) {
  const kind = session.projectKind;
  return kind === "main" ? "Main checkout" : kind === "worktree" ? "Git worktree" : kind === "no-repo" ? "No Git repository" : session.cwdExists === false ? "Directory unavailable" : "Project directory";
}

function SessionProjectIcon(componentProps: { session: SessionSummary }) {
  const kind = createMemo(() => (componentProps.session.projectKind));
  const Icon = createMemo(() => (kind() === "main" ? FolderGit2 : kind() === "worktree" ? GitBranch : Folder));
  return <span class="session-project-icon" title={projectKindLabel(componentProps.session)}><Dynamic component={Icon()} size={14} aria-hidden="true" /></span>;
}

function stableSessionOrder(left: SessionSummary, right: SessionSummary) {
  return sidebarCollator.compare(left.name, right.name) || sidebarCollator.compare(left.id, right.id);
}

function recentSessionOrder(left: SessionSummary, right: SessionSummary) {
  return right.lastMessageAt - left.lastMessageAt || stableSessionOrder(left, right);
}

function savedGroupKeys(storageKey: string) {
  try { const value = JSON.parse(localStorage.getItem(storageKey) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); }
  catch { return new Set<string>(); }
}

function savedSessionOrders() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_ORDERS_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")));
  } catch { return {}; }
}

function savedSidebarOrder() {
  try { const value = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) || "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

function sessionKey(session: SessionSummary) { return `${session.hostId ?? "local"}:${session.id}`; }
function physicalProjectKey(session: SessionSummary) { return `${session.hostId ?? "local"}:${session.projectRoot ?? session.cwd}`; }
function projectName(session: SessionSummary) { return session.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? session.project; }
function sessionLayoutToken(key: string) { return `session:${key}`; }
function groupLayoutToken(key: string) { return `group:${key}`; }
function disclosureId(key: string) {
  return `project-${[...new TextEncoder().encode(key)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function orderedSessions(projectKey: string, sessions: SessionSummary[], orders: Record<string, string[]>) {
  const customOrder = orders[projectKey];
  const defaultOrder = projectKey === RECENT_KEY ? recentSessionOrder : stableSessionOrder;
  if (!customOrder) return sessions.sort(defaultOrder);
  const positions = new Map(customOrder.map((key, index) => [key, index]));
  return sessions.sort((left, right) => {
    const leftPosition = positions.get(sessionKey(left)); const rightPosition = positions.get(sessionKey(right));
    if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
    if (leftPosition !== undefined) return projectKey === RECENT_KEY ? 1 : -1;
    if (rightPosition !== undefined) return projectKey === RECENT_KEY ? -1 : 1;
    return defaultOrder(left, right);
  });
}

function formatApiCost(cost = 0) {
  if (cost > 0 && cost < .01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function sessionPanelDefaults({ sessions, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction, onNewChat, onCreateWorktree, onDeleteWorktree, createGroupRequest = 0, onCreateGroupHandled }: Props) {
  return { sessions, activeId, activeHostId, runningSessions, unseenSessions, query, onQuery, onSelect, onAction, onNewChat, onCreateWorktree, onDeleteWorktree, createGroupRequest, onCreateGroupHandled };
}

function groupLabel(project: string, hostId: string, hostName: string | undefined) {
  return !hostId || hostId === "local" ? project : `${hostName ?? hostId} / ${project}`;
}

export function SessionPanel(props: Props) {
  const visibleSessions = createMemo(() => props.sessions.filter(session => !session.subagentParentId));
  const panelFields = createMemoFields(() => sessionPanelDefaults({ ...props, sessions: visibleSessions() }));
  const panel = () => panelFields;
  const [menu, setMenu] = createSignal<{ session: SessionSummary; x: number; y: number; returnFocus?: HTMLElement }>();
  const [groupMenu, setGroupMenu] = createSignal<{ projectKey: string; label: string; x: number; y: number; returnFocus: HTMLElement }>();
  const [collapsedProjects, setCollapsedProjects] = createSignal<Set<string>>((() => savedGroupKeys(COLLAPSED_PROJECTS_KEY))());
  const storedGroups = useSessionGroups(() => (panel().sessions));
  const savedGroups = createMemo(() => (storedGroups.state?.groups ?? []));
  const customGroups = createMemo(() => (savedGroups().filter((group) => !group.cwd)));
  const [removingGroup, setRemovingGroup] = createSignal<{ id: string; name: string }>();
  const [removingWorktree, setRemovingWorktree] = createSignal<{ id: string; name: string; cwd: string; hostId: string; conversationCount: number }>();
  const [groupSaving, setGroupSaving] = createSignal(false);
  const groupSavePending = createRef(false);
  const [groupActionError, setGroupActionError] = createSignal<string>();
  const [sessionOrders, setSessionOrders] = createSignal<Record<string, string[]>>((savedSessionOrders)());
  const [sidebarOrder, setSidebarOrder] = createSignal<string[]>((savedSidebarOrder)());
  const [newGroupName, setNewGroupName] = createSignal<string>();
  const [editingGroupId, setEditingGroupId] = createSignal<string>();
  const [groupDraftError, setGroupDraftError] = createSignal<string>();
  const [draggedSession, setDraggedSession] = createSignal<DraggedSession>();
  const [draggedProject, setDraggedProject] = createSignal<string>();
  const [dropTarget, setDropTarget] = createSignal<DropTarget>();
  const menuRef = createRef<HTMLDivElement>(null);
  const searchRef = createRef<HTMLInputElement>(null);
  const groupNameRef = createRef<HTMLInputElement>(null);
  const groupDraftActive = createRef(false);
  const mouseDragRef = createRef<MouseDrag | undefined>(undefined);
  const mouseDropTargetRef = createRef<DropTarget | undefined>(undefined);
  const suppressClickRef = createRef<string | undefined>(undefined);
  const sessionScrollRef = createRef<HTMLDivElement>(null);
  const autoScrollFrameRef = createRef<number | undefined>(undefined);
  const dragPointerRef = createRef<{ x: number; y: number } | undefined>(undefined);
  const groupedSessionsRef = createRef<Map<string, SessionSummary[]>>(new Map());
  const sidebarEntriesRef = createRef<string[]>([]);
  const removeMouseListenersRef = createRef<() => void>(() => { });
  const projectKindInspectionsRef = createRef(new Set<string>());
  const closeMenu = (restoreFocus = false) => { const target = groupMenu()?.returnFocus ?? menu()?.returnFocus; setMenu(undefined); setGroupMenu(undefined); if (restoreFocus) requestAnimationFrame(() => target?.focus()); };
  createDependencyEffect(() => { const capturedMenu = menu(); const capturedGroupMenu = groupMenu();
    if (!capturedMenu && !capturedGroupMenu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    const close = () => closeMenu();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(true); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    const scroll = sessionScrollRef.current; scroll?.addEventListener("scroll", close, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); scroll?.removeEventListener("scroll", close); };
  }, () => [menu(), groupMenu()]);
  createDependencyEffect(() => {
    const focusSearch = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, () => []);
  createDependencyEffect(() => { const capturedPanel = panel();
    if (!capturedPanel.createGroupRequest) return;
    groupDraftActive.current = true; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName("");
    sessionScrollRef.current?.scrollTo({ top: 0 });
    capturedPanel.onCreateGroupHandled?.();
  }, () => [panel().createGroupRequest, panel().onCreateGroupHandled]);
  createDependencyEffect(() => { const capturedNewGroupName = newGroupName();
    if (capturedNewGroupName === undefined) return;
    const frame = requestAnimationFrame(() => groupNameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, () => [newGroupName() === undefined, editingGroupId()]);
  createDependencyEffect(() => () => { removeMouseListenersRef.current(); if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current); }, () => []);
  createDependencyEffect(() => {
    const capturedMenu = menu(); const capturedPanel = panel();
 if (capturedMenu && !capturedPanel.sessions.some((session) => sessionKey(session) === sessionKey((capturedMenu)!.session))) closeMenu(); }, () => [menu(), panel().sessions]);
  createDependencyEffect(() => {
    for (const group of storedGroups.state?.groups ?? []) {
      if (!group.cwd || group.projectKind || projectKindInspectionsRef.current.has(group.id)) continue;
      projectKindInspectionsRef.current.add(group.id);
      void gitProjectKind(group.cwd, group.hostId ?? "local")
        .then((projectKind) => storedGroups.change({ type: "inspectProject", id: group.id, projectKind }))
        .catch(() => undefined);
    }
  }, () => [storedGroups.change, storedGroups.state?.groups]);
  const inferredWorktreeGroup = createMemo(() => (savedGroups().find((group) => group.cwd && group.projectKind !== "worktree" && panel().sessions.some((session) => (session.hostId ?? "local") === (group.hostId ?? "local") && session.cwd === group.cwd && session.projectKind === "worktree"))));
  createDependencyEffect(() => { const capturedInferredWorktreeGroup = inferredWorktreeGroup();
    if (!capturedInferredWorktreeGroup) return;
    void storedGroups.change({ type: "inspectProject", id: capturedInferredWorktreeGroup.id, projectKind: "worktree" }).catch(() => undefined);
  }, () => [storedGroups.change, inferredWorktreeGroup()?.id]);
  const groupNameTaken = (name: string, excludedId?: string) => sidebarCollator.compare(RECENT_LABEL, name.trim()) === 0 || storedGroups.state?.groups.some((group) => group.id !== excludedId && sidebarCollator.compare(group.name.trim(), name.trim()) === 0);
  const validateGroupName = (name: string) => {
    if (!name || !hasVisibleText(name)) return "Enter a group name.";
    if (name.length > 80) return "Keep the group name under 80 characters.";
    if (groupNameTaken(name, editingGroupId())) return "A project or group already uses that name.";
  };
  const finishGroup = async (cancel = false) => { const capturedNewGroupName = newGroupName(); const capturedEditingGroupId = editingGroupId();
    if (!groupDraftActive.current || groupSavePending.current) return;
    const name = (capturedNewGroupName ?? "").trim();
    if (cancel) { groupDraftActive.current = false; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName(undefined); return; }
    const error = validateGroupName(name);
    if (error) { setGroupDraftError(error); return; }
    if (!storedGroups.state) { setGroupDraftError("Groups are still loading."); return; }
    groupSavePending.current = true; setGroupSaving(true);
    try {
      await storedGroups.change(capturedEditingGroupId ? { type: "rename", id: (capturedEditingGroupId)!, name } : { type: "create", name });
      groupDraftActive.current = false; setGroupDraftError(undefined); setNewGroupName(undefined); setEditingGroupId(undefined);
    } catch (reason) { setGroupDraftError(String(reason)); }
    finally { groupSavePending.current = false; setGroupSaving(false); }
  };
  const editGroup = (group: CustomGroup) => { groupDraftActive.current = true; setEditingGroupId(group.id); setGroupDraftError(undefined); setNewGroupName(group.name); requestAnimationFrame(() => groupNameRef.current?.select()); };
  const removeGroup = async (projectKey: string) => { const capturedPanel = panel(); const capturedSessionOrders = sessionOrders();
    const releasedSessions = orderedSessions(projectKey, capturedPanel.sessions.filter((session) => visualProjectKey(session) === projectKey), capturedSessionOrders);
    const releasedTokens = releasedSessions.map((session) => sessionLayoutToken(sessionKey(session)));
    await storedGroups.change({ type: "remove", id: projectKey });
    setSessionOrders((current) => { const next = { ...current }; delete next[projectKey]; try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { } return next; });
    setCollapsedProjects((current) => { const next = new Set(current); next.delete(projectKey); try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { } return next; });
    setSidebarOrder((current) => {
      const token = groupLayoutToken(projectKey);
      const next = current.filter((entry) => !releasedTokens.includes(entry));
      const index = next.indexOf(token);
      next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, ...releasedTokens);
      try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  };
  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { }
    return next;
  });
  const expandProject = (projectKey: string) => {
    setCollapsedProjects((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current); next.delete(projectKey);
      try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { }
      return next;
    });
  };
  const moveSession = (drag: DraggedSession, destinationKey: string, destinationSessions: SessionSummary[], targetKey?: string, edge: "before" | "after" = "after") => {
    if (!groupedSessionsRef.current.has(destinationKey)) return;
    if (drag.projectKey === destinationKey && drag.sessionKey === targetKey) return;
    const nextOrder = destinationSessions.map(sessionKey).filter((key) => key !== drag.sessionKey);
    const targetIndex = targetKey ? nextOrder.indexOf(targetKey) : -1;
    nextOrder.splice(targetIndex < 0 ? nextOrder.length : targetIndex + (edge === "after" ? 1 : 0), 0, drag.sessionKey);
    setSessionOrders((current) => {
      const next = { ...current, [destinationKey]: nextOrder };
      try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
    return storedGroups.change({ type: "assign", key: drag.sessionKey, group: destinationKey === RECENT_KEY ? null : destinationKey }).catch(() => undefined);
  };
  const placeSidebarEntry = (token: string, beforeToken: string | null) => {
    const currentEntries = sidebarEntriesRef.current;
    if (beforeToken === token) return;
    const next = currentEntries.filter((entry) => entry !== token);
    const targetIndex = beforeToken === null ? -1 : next.indexOf(beforeToken);
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, token);
    setSidebarOrder(next);
    try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { }
  };
  const projectDetails = createMemo(() => {
    const details = new Map<string, SessionSummary>();
    panel().sessions.forEach(session => { const key = physicalProjectKey(session); if (!details.has(key)) details.set(key, session); });
    return details;
  });
  const normalizedQuery = createMemo(() => (panel().query.trim().toLowerCase()));
  const customGroupsByKey = createMemo(() => (new Map(customGroups().map((group) => [group.id, group]))));
  const visualProjectKey = (session: SessionSummary) => {
    const destination = storedGroups.state?.assignments[sessionKey(session)];
    if (!destination) return RECENT_KEY;
    const group = (storedGroups.state)!?.groups.find((item) => item.id === destination);
    return group?.cwd && isTemporaryChatCwd(group.cwd) ? RECENT_KEY : destination;
  };
  const filtered = createMemo(() => (panel().sessions.filter((session) => {
    if (!storedGroups.state) return false;
    if (!normalizedQuery()) return true;
    const location = visualProjectKey(session);
    const groupName = location === RECENT_KEY ? RECENT_LABEL : (storedGroups.state)!?.groups.find((group) => group.id === location)?.name ?? "";
    return `${session.name} ${session.project} ${projectName(session)} ${session.preview} ${session.hostName ?? session.hostId ?? "Local"} ${groupName}`.toLowerCase().includes(normalizedQuery());
  })));
  const groupedSessions = createMemo(() => (filtered().reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[visualProjectKey(session)] ??= []).push(session); return result;
  }, {})));
  const recentSessions = createMemo(() => (orderedSessions(RECENT_KEY, groupedSessions()[RECENT_KEY] ?? [], sessionOrders())));
  const recentKeys = createMemo(() => (recentSessions().map(sessionKey).join("\n")));
  createDependencyEffect(() => { const capturedNormalizedQuery = normalizedQuery(); const capturedRecentKeys = recentKeys();
    if (capturedNormalizedQuery) return;
    setSessionOrders((current) => {
      const saved = current[RECENT_KEY];
      if (!saved) return current;
      const known = new Set(saved);
      const added = capturedRecentKeys.split("\n").filter((key) => key && !known.has(key));
      if (!added.length) return current;
      const next = { ...current, [RECENT_KEY]: [...added, ...saved] };
      try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  }, () => [recentKeys(), normalizedQuery()]);
  const physicalGroups = createMemo(() => (savedGroups().filter((group) => group.cwd && !isTemporaryChatCwd(group.cwd)).map((group) => [group.id, group.name, group.hostId ?? "local", group.hostName ?? undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())] as const)));
  const customVisualGroups = createMemo(() => (customGroups().map((group) => [group.id, group.name, "", undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())] as const)));
  const projectOrderKey = createMemo(() => (JSON.stringify(savedGroups().map((group) => groupLayoutToken(group.id)))));
  createDependencyEffect(() => { const capturedProjectOrderKey = projectOrderKey();
    const projectTokens: string[] = JSON.parse(capturedProjectOrderKey);
    setSidebarOrder((current) => {
      const added = projectTokens.filter((token) => !current.includes(token));
      if (!added.length) return current;
      const next = [...added, ...current];
      try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { }
      return next;
    });
  }, () => [projectOrderKey()]);
  const groups = createMemo(() => ([
    ...customVisualGroups().filter(([, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0),
    ...physicalGroups().filter(([, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0),
    ...(recentSessions().length ? [[RECENT_KEY, RECENT_LABEL, "", undefined, recentSessions()] as const] : []),
  ]));
  createComputed(() => { groupedSessionsRef.current = new Map([[RECENT_KEY, recentSessions()], ...groups().map(([key, , , , projectSessions]) => [key, projectSessions] as const)]); });
  const defaultSidebarEntries = createMemo(() => (groups().map(([key]) => groupLayoutToken(key))));
  const recentToken = createMemo(() => (groupLayoutToken(RECENT_KEY)));
  const orderedSidebarEntries = (entries: string[]) => {
    const availableEntries = new Set(entries);
    const addedEntries = entries.filter((entry) => !sidebarOrder().includes(entry));
    return [...addedEntries.filter((entry) => entry !== recentToken()), ...sidebarOrder().filter((entry) => availableEntries.has(entry)), ...addedEntries.filter((entry) => entry === recentToken())];
  };
  const sidebarEntries = createMemo(() => (orderedSidebarEntries(defaultSidebarEntries())));
  const keyboardSidebarEntries = createMemo(() => (defaultSidebarEntries().includes(recentToken()) ? sidebarEntries() : orderedSidebarEntries([...defaultSidebarEntries(), recentToken()])));
  createComputed(() => { sidebarEntriesRef.current = sidebarEntries(); });
  const selectedProjectKey = () => {
    const activeSession = panel().sessions.find((session) => session.id === panel().activeId && (session.hostId ?? "local") === panel().activeHostId);
    return activeSession ? visualProjectKey(activeSession) : undefined;
  };
  const activeProjectKey = createMemo(() => (selectedProjectKey()));
  const moveSessionByKeyboard = (drag: DraggedSession, direction: -1 | 1, betweenGroups: boolean) => {
    const sourceSessions = groupedSessionsRef.current.get(drag.projectKey) ?? [];
    const focused = document.activeElement;
    const restoreFocus = () => requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== focused) return;
      sessionScrollRef.current?.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(drag.sessionKey)}"] .session-main`)?.focus({ preventScroll: true });
    });
    if (betweenGroups) {
      const destinationKeys = keyboardSidebarEntries().filter((token) => token.startsWith("group:")).map((token) => token.slice("group:".length));
      const sourceIndex = destinationKeys.indexOf(drag.projectKey); const destinationKey = destinationKeys[sourceIndex + direction];
      if (!destinationKey) return;
      void moveSession(drag, destinationKey, groupedSessionsRef.current.get(destinationKey) ?? [])?.then(restoreFocus); expandProject(destinationKey);
      return;
    }
    const sourceIndex = sourceSessions.findIndex((session) => sessionKey(session) === drag.sessionKey); const target = sourceSessions[sourceIndex + direction];
    if (!target) return;
    void moveSession(drag, drag.projectKey, sourceSessions, sessionKey(target), direction < 0 ? "before" : "after")?.then(restoreFocus);
  };
  const startMouseDrag = (event: MouseEvent<HTMLElement>, drag: DraggedItem) => {
    if (normalizedQuery() || event.button !== 0) return;
    removeMouseListenersRef.current();
    const mouseDrag: MouseDrag = { ...drag, startX: event.clientX, startY: event.clientY, active: false };
    mouseDragRef.current = mouseDrag;
    const clear = () => {
      removeMouseListenersRef.current();
      mouseDragRef.current = undefined;
      mouseDropTargetRef.current = undefined;
      setDraggedSession(undefined);
      setDraggedProject(undefined);
      setDropTarget(undefined);
      dragPointerRef.current = undefined;
      if (autoScrollFrameRef.current !== undefined) { cancelAnimationFrame(autoScrollFrameRef.current); autoScrollFrameRef.current = undefined; }
    };
    const projectDropTarget = (hit: HTMLElement | null, y: number, projectKey: string): DropTarget | undefined => {
      const entryElement = hit?.closest<HTMLElement>("section[data-sidebar-token], .session-item[data-sidebar-token]");
      const token = entryElement?.dataset.sidebarToken;
      if (!entryElement || !token || token === groupLayoutToken(projectKey)) return;
      const bounds = entryElement.getBoundingClientRect();
      const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
      const index = sidebarEntriesRef.current.indexOf(token);
      return { projectKey: RECENT_KEY, sessionKey: "", edge, layoutBefore: edge === "before" ? token : sidebarEntriesRef.current[index + 1] ?? null };
    };
    const emptyProjectDrop = (hit: HTMLElement | null): DropTarget | undefined => {
      const projectElement = hit?.closest<HTMLElement>("[data-drop-project-key]");
      return projectElement ? { projectKey: projectElement.dataset.dropProjectKey!, sessionKey: "", edge: "after" } : undefined;
    };
    const updateDropTarget = (x: number, y: number, current: MouseDrag) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      let nextTarget: DropTarget | undefined;
      const sidebarDropZone = hit?.closest<HTMLElement>("[data-sidebar-drop-zone]");
      const sessionElement = hit?.closest<HTMLElement>(".session-item[data-session-key]");
      if (sidebarDropZone) {
        nextTarget = { projectKey: RECENT_KEY, sessionKey: "", edge: "after", layoutBefore: sidebarDropZone.dataset.sidebarEnd === "true" ? null : sidebarDropZone.dataset.sidebarBefore! };
      } else if (!("session" in current)) {
        nextTarget = projectDropTarget(hit, y, current.projectKey);
      } else if (sessionElement && sessionElement.dataset.sessionKey !== current.sessionKey) {
        const bounds = sessionElement.getBoundingClientRect();
        const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
        const projectKey = sessionElement.dataset.projectKey!; const targetKey = sessionElement.dataset.sessionKey!;
        nextTarget = { projectKey, sessionKey: targetKey, edge };
      } else if (!sessionElement) {
        nextTarget = emptyProjectDrop(hit);
      }
      mouseDropTargetRef.current = nextTarget;
      setDropTarget(nextTarget);
    };
    const autoScroll = () => {
      autoScrollFrameRef.current = undefined;
      const pointer = dragPointerRef.current; const scroll = sessionScrollRef.current; const current = mouseDragRef.current;
      if (!pointer || !scroll || !current?.active) return;
      const bounds = scroll.getBoundingClientRect(); const edgeSize = 42;
      const speed = pointer.y < bounds.top + edgeSize ? -Math.ceil((bounds.top + edgeSize - pointer.y) / 4) : pointer.y > bounds.bottom - edgeSize ? Math.ceil((pointer.y - (bounds.bottom - edgeSize)) / 4) : 0;
      if (speed) { scroll.scrollTop += speed; updateDropTarget(pointer.x, pointer.y, current); autoScrollFrameRef.current = requestAnimationFrame(autoScroll); }
    };
    const move = (mouseEvent: MouseEvent) => {
      const current = mouseDragRef.current;
      if (!current) return;
      if (!current.active && Math.hypot(mouseEvent.clientX - current.startX, mouseEvent.clientY - current.startY) < 5) return;
      if (!current.active) { current.active = true; if ("session" in current) setDraggedSession(current); else setDraggedProject(current.projectKey); }
      mouseEvent.preventDefault(); dragPointerRef.current = { x: mouseEvent.clientX, y: mouseEvent.clientY };
      updateDropTarget(mouseEvent.clientX, mouseEvent.clientY, current);
      if (autoScrollFrameRef.current === undefined) autoScrollFrameRef.current = requestAnimationFrame(autoScroll);
    };
    const finish = () => {
      const current = mouseDragRef.current;
      if (!current) return;
      if (current.active) {
        const sourceToken = "session" in current ? sessionLayoutToken(current.sessionKey) : groupLayoutToken(current.projectKey);
        suppressClickRef.current = sourceToken;
        window.setTimeout(() => { if (suppressClickRef.current === sourceToken) suppressClickRef.current = undefined; }, 0);
        const target = mouseDropTargetRef.current;
        if (target) {
          if ("session" in current) {
            moveSession(current, target.projectKey, groupedSessionsRef.current.get(target.projectKey) ?? [], target.sessionKey || undefined, target.edge);
            if (target.layoutBefore !== undefined) placeSidebarEntry(groupLayoutToken(RECENT_KEY), target.layoutBefore);
            expandProject(target.projectKey);
          } else if (target.layoutBefore !== undefined) placeSidebarEntry(sourceToken, target.layoutBefore);
        }
      }
      clear();
    };
    const cancel = () => clear();
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", cancel);
    removeMouseListenersRef.current = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", cancel);
      removeMouseListenersRef.current = () => { };
    };
  };
  const projectDragProps = (projectKey: string) => ({
    onMouseDown: (event: MouseEvent<HTMLElement>) => startMouseDrag(event, { projectKey }),
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (suppressClickRef.current === groupLayoutToken(projectKey)) { suppressClickRef.current = undefined; event.preventDefault(); return; }
      toggleProject(projectKey);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (normalizedQuery() || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const entries = sidebarEntriesRef.current; const token = groupLayoutToken(projectKey); const index = entries.indexOf(token);
      const direction = event.key === "ArrowUp" ? -1 : 1;
      if (index + direction < 0 || index + direction >= entries.length) return;
      placeSidebarEntry(token, direction < 0 ? entries[index - 1] : entries[index + 2] ?? null);
    },
    "aria-description": !normalizedQuery() ? "Drag to reorder. Press Alt plus Up or Down to reorder." : undefined,
    "aria-keyshortcuts": !normalizedQuery() ? "Alt+ArrowUp Alt+ArrowDown" : undefined,
  });
  const isActiveSession = (session: SessionSummary) => panel().activeId === session.id && (session.hostId ?? "local") === panel().activeHostId;
  const isSavedSession = (session: SessionSummary) => !session.isDraft && Boolean(session.path);
  const SessionRow = (row: { session: SessionSummary; projectKey: string }) => {
    const session = () => row.session;
    const projectKey = row.projectKey;
    const key = createMemo(() => sessionKey(session()));
    const running = createMemo(() => session().isRunning || panel().runningSessions.has(key()));
    const activity = createMemo(() => panel().unseenSessions.has(key()) ? "New activity" : undefined);
    const accessibleActivity = () => running() ? "Running" : activity();
    const target = createMemo(() => dropTarget()?.projectKey === projectKey && dropTarget()?.sessionKey === key() ? dropTarget()?.edge : undefined);
    const drag = () => ({ projectKey, sessionKey: key(), session: session() });
    const renderSessionMain = () => (<button class="session-main" aria-label={`${session().name}, ${projectKindLabel(session())}, ${formatApiCost(session().apiCost)}${accessibleActivity() ? `, ${accessibleActivity()}` : ""}`} aria-current={isActiveSession(session()) ? "page" : undefined} aria-description={!normalizedQuery() ? "Press Alt plus Up or Down to reorder. Add Shift to move between groups." : undefined} aria-keyshortcuts={!normalizedQuery() ? "Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined} onMouseDown={(event) => startMouseDrag(event, drag())} onKeyDown={(event) => { if (!normalizedQuery() && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); moveSessionByKeyboard(drag(), event.key === "ArrowUp" ? -1 : 1, event.shiftKey); } }} onClick={(event) => { if (suppressClickRef.current === sessionLayoutToken(key())) { suppressClickRef.current = undefined; event.preventDefault(); return; } panel().onSelect(session()); }}><span class="session-copy"><span class="session-title-row">{session().projectKind !== "no-repo" && <SessionProjectIcon session={session()} />}<strong>{session().name}</strong><span class="session-api-cost" title="Would-be API cost">{formatApiCost(session().apiCost)}</span></span></span></button>);
    return <div  data-session-key={key()} data-project-key={projectKey} class={`session-item ${!normalizedQuery() ? "reorderable" : ""} ${isActiveSession(session()) ? "active" : ""} ${running() ? "running" : activity() ? "unseen" : ""} ${draggedSession()?.sessionKey === key() ? "dragging" : ""} ${target() ? `drop-${target()}` : ""}`} onContextMenu={(event) => { event.preventDefault(); const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined; setGroupMenu(undefined); setMenu({ session: session(), x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190), returnFocus }); }}>
      {renderSessionMain()}
      <button class="session-archive" aria-label={`Archive ${session().name}`} title={!isSavedSession(session()) ? "Send a message before archiving this draft" : `Archive ${session().name}`} disabled={!isSavedSession(session())} onClick={() => panel().onAction(session(), "archive")}><Archive size={14} /></button>
    </div>;
  };
  const prepareWorktreeRemoval = async (id: string, name: string, group: SessionGroup) => { const capturedPanel = panel();
    const cwd = group.cwd!; const hostId = group.hostId ?? "local";
    const hostSessions = capturedPanel.sessions.filter((session) => (session.hostId ?? "local") === hostId);
    setGroupActionError(undefined);
    try {
      const [targetRoot, ...conversationRoots] = await gitWorktreeRoots([cwd, ...hostSessions.map((session) => session.cwd)], hostId);
      if (!targetRoot) throw new Error("Could not resolve the worktree directory");
      setRemovingWorktree({ id, name, cwd, hostId, conversationCount: conversationRoots.filter((root) => root === targetRoot).length });
    } catch (reason) { setGroupActionError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const groupsByToken = createMemo(() => (new Map(groups().map((group) => [groupLayoutToken(group[0]), group] as const))));
  const groupMenuDetails = () => {
    const groupDirectory = groupMenu() ? storedGroups.state?.groups.find((group) => group.id === (groupMenu())!.projectKey && group.cwd) : undefined;
    const groupDirectorySession = groupDirectory && panel().sessions.find((session) => (session.hostId ?? "local") === (groupDirectory.hostId ?? "local") && session.cwd === groupDirectory.cwd);
    const isWorktreeGroup = groupDirectory?.projectKind === "worktree" || groupDirectorySession?.projectKind === "worktree";
    return { groupDirectory, isWorktreeGroup };
  };
  const contextMenu = () => {
    const activeMenu = groupMenu() ?? menu();
    const { groupDirectory, isWorktreeGroup } = groupMenuDetails();
    const menuItems = groupMenu() ? [
      { label: "Open directory", Icon: FolderOpen, disabled: !groupDirectory, run: () => { if (groupDirectory?.cwd) { setGroupActionError(undefined); void openGroupDirectory(groupDirectory.cwd, groupDirectory.hostId ?? "local").catch((reason) => setGroupActionError(String(reason))); } } },
      { label: "Create worktree", Icon: GitBranch, disabled: !groupDirectory, run: () => { if (groupDirectory?.cwd) panel().onCreateWorktree(groupDirectory.cwd, groupDirectory.hostId ?? "local"); } },
      ...(isWorktreeGroup && groupDirectory?.cwd ? [{ label: "Delete worktree…", Icon: Trash2, disabled: false, run: () => void prepareWorktreeRemoval((groupMenu())!.projectKey, (groupMenu())!.label, groupDirectory) }] : []),
      { label: "Forget group", Icon: Trash2, disabled: false, run: () => setRemovingGroup({ id: (groupMenu())!.projectKey, name: (groupMenu())!.label }) },
    ] : menu() ? actions.filter(([action]) => action !== "split" || (menu())!.session.id !== panel().activeId || ((menu())!.session.hostId ?? "local") !== panel().activeHostId).map(([action, Icon, label]) => ({ label, Icon, disabled: action === "clone" && Boolean(menu()!.session.isDraft || !menu()!.session.path), run: () => panel().onAction((menu())!.session, action) })) : [];
    return { activeMenu, menuItems };
  };
  const menuActions = createMemo(() => (contextMenu()));
  const isEditingGroup = (projectKey: string) => customGroupsByKey().has(projectKey) && editingGroupId() === customGroupsByKey().get(projectKey)?.id;
  const renderDropZone = (beforeToken: string | null) => (<div  data-sidebar-drop-zone data-sidebar-before={beforeToken ?? undefined} data-sidebar-end={beforeToken === null ? true : undefined} class={`sidebar-drop-zone ${dropTarget()?.layoutBefore === beforeToken ? "active" : ""}`} />);
  const renderSessionScroll = () => {
    const renderGroupError = () => ((storedGroups.error || groupActionError()) && <p class="group-error" role="alert">{storedGroups.error || groupActionError()}</p>);
    const renderGroupLoading = () => (!storedGroups.state && !storedGroups.error && <p class="empty-small">Loading groups…</p>);
    const renderNewGroup = () => (<Show when={newGroupName() !== undefined && !editingGroupId()}><section class="project custom-group-draft"><div class="project-label"><input ref={element => { groupNameRef.current = element; }} disabled={groupSaving()} aria-label="New session group name" aria-invalid={Boolean(groupDraftError())} aria-describedby={groupDraftError() ? "new-group-error" : undefined} placeholder="Group name" value={(newGroupName())!} onInput={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup(true)} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} /></div>{groupDraftError() && <small id="new-group-error" class="group-error">{(groupDraftError())!}</small>}</section></Show>);
    const renderEmptyConversations = () => (storedGroups.state && !filtered().length && <div class="empty-small">{normalizedQuery() ? `No conversations match “${panel().query.trim()}”.` : "No conversations yet."}</div>);
    return (<div ref={element => { sessionScrollRef.current = element; }} class="session-scroll">
      {renderGroupError()}
      {renderGroupLoading()}
      {renderNewGroup()}
      {<Key each={sidebarEntries().filter((token) => groupsByToken().has(token))} by={(token) => token}>{(token) => {
        const group = () => groupsByToken().get(token())!; const projectKey = group()[0]; const label = () => groupLabel(group()[1], group()[2], group()[3]); const collapsed = () => !normalizedQuery() && collapsedProjects().has(projectKey); const groupId = disclosureId(projectKey); const renderProjectHeading = () => {
          const renderProjectLabel = () => {
            const renderGroupNameInput = () => (<input ref={element => { groupNameRef.current = element; }} disabled={groupSaving()} aria-label="Rename session group" aria-invalid={Boolean(groupDraftError())} aria-describedby={groupDraftError() ? "rename-group-error" : undefined} value={newGroupName() ?? ""} onInput={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} />);
            return (isEditingGroup(projectKey) ? <div class="project-label">{renderGroupNameInput()}{groupDraftError() && <small id="rename-group-error" class="group-error">{(groupDraftError())!}</small>}</div> : <>
              <button class="project-label" disabled={Boolean(normalizedQuery())} aria-expanded={!collapsed()} aria-controls={groupId} {...projectDragProps(projectKey)}><ChevronDown class={collapsed() ? "collapsed" : ""} size={13} />{projectDetails().get(projectKey)?.projectKind === "no-repo" && <Folder size={14} aria-hidden="true" />}<span class={projectKey === activeProjectKey() ? "active" : undefined}>{label()}</span></button>
              {projectKey !== RECENT_KEY && <div class="project-actions">
                {customGroupsByKey().has(projectKey) && <button aria-label={`Rename group ${label()}`} title="Rename group" onClick={() => editGroup(customGroupsByKey().get(projectKey)!)}><Pencil size={12} /></button>}
                <button aria-label={`New chat in ${label()}`} title="New chat in group" onClick={() => {
                  const destination = storedGroups.state?.groups.find((item) => item.id === projectKey);
                  if (!destination) return;
                  expandProject(projectKey);
                  panel().onNewChat(destination);
                }}><MessageSquarePlus size={14} /></button>
                <button aria-label={`Group actions for ${label()}`} title="Group actions" aria-haspopup="menu" aria-expanded={groupMenu()?.projectKey === projectKey} onClick={(event) => {
                  event.stopPropagation();
                  if (groupMenu()?.projectKey === projectKey) { closeMenu(true); return; }
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setMenu(undefined);
                  setGroupMenu({ projectKey, label: label(), x: Math.max(8, Math.min(bounds.right - 188, window.innerWidth - 196)), y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 148)), returnFocus: event.currentTarget });
                }}><Ellipsis size={14} /></button>
              </div>}
            </>);
          };
          return (<div class="project-heading" data-drop-project-key={projectKey}>
            {renderProjectLabel()}
          </div>);
        };
        return [renderDropZone(token()), <section data-sidebar-token={token()} class={`project ${!normalizedQuery() ? "reorderable" : ""} ${draggedProject() === projectKey ? "dragging" : ""} ${dropTarget()?.projectKey === projectKey && !(dropTarget())!.sessionKey && (dropTarget())!.layoutBefore === undefined ? "drop-project" : ""}`} >
          {renderProjectHeading()}
          <div id={groupId} hidden={collapsed()}><Key each={group()[4]} by={sessionKey}>{session => <SessionRow session={session()} projectKey={projectKey} />}</Key></div>
        </section>];
      }}</Key>}
      {sidebarEntries().length > 0 && renderDropZone(null)}
      {renderEmptyConversations()}
    </div>);
  };
  const renderConversationMenu = () => (menuActions().activeMenu && <div ref={element => { menuRef.current = element; }} class="conversation-menu session-context-menu" role="menu" aria-label={`${groupMenu()?.label ?? menu()?.session.name} actions`} style={{ left: cssPixels((menuActions().activeMenu)!.x), top: cssPixels((menuActions().activeMenu)!.y) }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    }}>{<Key each={menuActions().menuItems} by={({ label }) => label}>{(entry, _index) => <button  role="menuitem" disabled={entry().disabled} title={entry().disabled ? groupMenu() ? "Custom groups have no directory" : "Send a message before cloning this draft" : undefined} onClick={() => { const run = entry().run; run(); closeMenu(true); }}><Dynamic component={entry().Icon} size={14} />{entry().label}</button>}</Key>}</div>);
  return <aside class="session-panel">
    {removingGroup() && <RemoveGroupDialog name={(removingGroup())!.name} onCancel={() => setRemovingGroup(undefined)} onRemove={async () => {
    const capturedRemovingGroup = removingGroup();
 await removeGroup((capturedRemovingGroup)!.id); setRemovingGroup(undefined); }} />}
    {removingWorktree() && <RemoveWorktreeDialog name={(removingWorktree())!.name} path={(removingWorktree())!.cwd} conversationCount={(removingWorktree())!.conversationCount} onCancel={() => setRemovingWorktree(undefined)} onRemove={async (deleteBranch) => { const capturedPanel = panel(); const capturedRemovingWorktree = removingWorktree();
      await capturedPanel.onDeleteWorktree((capturedRemovingWorktree)!.cwd, (capturedRemovingWorktree)!.hostId, deleteBranch);
      try { await removeGroup((capturedRemovingWorktree)!.id); }
      catch (reason) { setGroupActionError(`Worktree deleted, but its sidebar group could not be forgotten: ${String(reason)}`); }
      setRemovingWorktree(undefined);
    }} />}
    <label class="search"><Search size={15} /><input ref={element => { searchRef.current = element; }} aria-label="Search conversations" placeholder="Search conversations" value={panel().query} onInput={(event) => panel().onQuery(event.target.value)} /><kbd>Ctrl G</kbd></label>
    {renderSessionScroll()}
    {renderConversationMenu()}
  </aside>;
}
