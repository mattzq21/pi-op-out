import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, Columns2, CopyPlus, Ellipsis, Folder, FolderOpen, FolderGit2, GitBranch, MessageSquarePlus, Pencil, Search, Trash2, AppWindow } from "lucide-react";
import type { SessionSummary } from "../types";
import { isTemporaryChatCwd, useSessionGroups, type SessionGroup } from "../lib/sessionGroups";
import { gitProjectKind, gitWorktreeRoots, openGroupDirectory } from "../lib/nativeTransport";
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

function SessionProjectIcon({ session }: { session: SessionSummary }) {
  const kind = session.projectKind;
  const Icon = kind === "main" ? FolderGit2 : kind === "worktree" ? GitBranch : Folder;
  return <span className="session-project-icon" title={projectKindLabel(session)}><Icon size={14} aria-hidden="true" /></span>;
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
  if (!customOrder) return sessions.sort(stableSessionOrder);
  const positions = new Map(customOrder.map((key, index) => [key, index]));
  return sessions.sort((left, right) => {
    const leftPosition = positions.get(sessionKey(left)); const rightPosition = positions.get(sessionKey(right));
    if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
    if (leftPosition !== undefined) return -1;
    if (rightPosition !== undefined) return 1;
    return stableSessionOrder(left, right);
  });
}

function formatApiCost(cost = 0) {
  if (cost > 0 && cost < .01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function SessionPanel({ sessions, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction, onNewChat, onCreateWorktree, onDeleteWorktree, createGroupRequest = 0, onCreateGroupHandled }: Props) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number; returnFocus?: HTMLElement }>();
  const [groupMenu, setGroupMenu] = useState<{ projectKey: string; label: string; x: number; y: number; returnFocus: HTMLElement }>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => savedGroupKeys(COLLAPSED_PROJECTS_KEY));
  const { state: storedGroups, error: groupStorageError, change: changeGroup } = useSessionGroups(sessions);
  const customGroups = storedGroups?.groups.filter((group) => !group.cwd) ?? [];
  const [removingGroup, setRemovingGroup] = useState<{ id: string; name: string }>();
  const [removingWorktree, setRemovingWorktree] = useState<{ id: string; name: string; cwd: string; hostId: string; conversationCount: number }>();
  const [groupSaving, setGroupSaving] = useState(false);
  const groupSavePending = useRef(false);
  const [groupActionError, setGroupActionError] = useState<string>();
  const [sessionOrders, setSessionOrders] = useState<Record<string, string[]>>(savedSessionOrders);
  const [sidebarOrder, setSidebarOrder] = useState<string[]>(savedSidebarOrder);
  const [newGroupName, setNewGroupName] = useState<string>();
  const [editingGroupId, setEditingGroupId] = useState<string>();
  const [groupDraftError, setGroupDraftError] = useState<string>();
  const [draggedSession, setDraggedSession] = useState<DraggedSession>();
  const [draggedProject, setDraggedProject] = useState<string>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const groupNameRef = useRef<HTMLInputElement>(null);
  const groupDraftActive = useRef(false);
  const mouseDragRef = useRef<MouseDrag | undefined>(undefined);
  const mouseDropTargetRef = useRef<DropTarget | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const sessionScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const dragPointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const groupedSessionsRef = useRef<Map<string, SessionSummary[]>>(new Map());
  const sidebarEntriesRef = useRef<string[]>([]);
  const removeMouseListenersRef = useRef<() => void>(() => {});
  const projectKindInspectionsRef = useRef(new Set<string>());
  const closeMenu = (restoreFocus = false) => { const target = groupMenu?.returnFocus ?? menu?.returnFocus; setMenu(undefined); setGroupMenu(undefined); if (restoreFocus) requestAnimationFrame(() => target?.focus()); };
  useEffect(() => {
    if (!menu && !groupMenu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    const close = () => closeMenu();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(true); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    const scroll = sessionScrollRef.current; scroll?.addEventListener("scroll", close, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); scroll?.removeEventListener("scroll", close); };
  }, [menu, groupMenu]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    if (!createGroupRequest) return;
    groupDraftActive.current = true; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName("");
    sessionScrollRef.current?.scrollTo({ top: 0 });
    onCreateGroupHandled?.();
  }, [createGroupRequest, onCreateGroupHandled]);
  useEffect(() => {
    if (newGroupName === undefined) return;
    const frame = requestAnimationFrame(() => groupNameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [newGroupName === undefined, editingGroupId]);
  useEffect(() => () => { removeMouseListenersRef.current(); if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current); }, []);
  useEffect(() => { if (menu && !sessions.some((session) => sessionKey(session) === sessionKey(menu.session))) closeMenu(); }, [menu, sessions]);
  useEffect(() => {
    for (const group of storedGroups?.groups ?? []) {
      if (!group.cwd || group.projectKind || projectKindInspectionsRef.current.has(group.id)) continue;
      projectKindInspectionsRef.current.add(group.id);
      void gitProjectKind(group.cwd, group.hostId ?? "local")
        .then((projectKind) => changeGroup({ type: "project", project: { ...group, projectKind } }))
        .catch(() => undefined);
    }
  }, [changeGroup, storedGroups?.groups]);
  const inferredWorktreeGroup = storedGroups?.groups.find((group) => group.cwd && group.projectKind !== "worktree" && sessions.some((session) => (session.hostId ?? "local") === (group.hostId ?? "local") && session.cwd === group.cwd && session.projectKind === "worktree"));
  useEffect(() => {
    if (!inferredWorktreeGroup) return;
    void changeGroup({ type: "project", project: { ...inferredWorktreeGroup, projectKind: "worktree" } }).catch(() => undefined);
  }, [changeGroup, inferredWorktreeGroup?.id]);
  const groupNameTaken = (name: string, excludedId?: string) => sidebarCollator.compare(RECENT_LABEL, name.trim()) === 0 || storedGroups?.groups.some((group) => group.id !== excludedId && sidebarCollator.compare(group.name.trim(), name.trim()) === 0);
  const finishGroup = async (cancel = false) => {
    if (!groupDraftActive.current || groupSavePending.current) return;
    const name = newGroupName?.trim();
    if (cancel) { groupDraftActive.current = false; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName(undefined); return; }
    if (!name) { setGroupDraftError("Enter a group name."); return; }
    if (groupNameTaken(name, editingGroupId)) { setGroupDraftError("A project or group already uses that name."); return; }
    if (!storedGroups) { setGroupDraftError("Groups are still loading."); return; }
    groupSavePending.current = true; setGroupSaving(true);
    try {
      await changeGroup(editingGroupId ? { type: "rename", id: editingGroupId, name } : { type: "create", name });
      groupDraftActive.current = false; setGroupDraftError(undefined); setNewGroupName(undefined); setEditingGroupId(undefined);
    } catch (reason) { setGroupDraftError(String(reason)); }
    finally { groupSavePending.current = false; setGroupSaving(false); }
  };
  const editGroup = (group: CustomGroup) => { groupDraftActive.current = true; setEditingGroupId(group.id); setGroupDraftError(undefined); setNewGroupName(group.name); requestAnimationFrame(() => groupNameRef.current?.select()); };
  const removeGroup = async (projectKey: string) => {
    const releasedSessions = orderedSessions(projectKey, sessions.filter((session) => visualProjectKey(session) === projectKey), sessionOrders);
    const releasedTokens = releasedSessions.map((session) => sessionLayoutToken(sessionKey(session)));
    await changeGroup({ type: "remove", id: projectKey });
    setSessionOrders((current) => { const next = { ...current }; delete next[projectKey]; try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ } return next; });
    setCollapsedProjects((current) => { const next = new Set(current); next.delete(projectKey); try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ } return next; });
    setSidebarOrder((current) => {
      const token = groupLayoutToken(projectKey);
      const next = current.filter((entry) => !releasedTokens.includes(entry));
      const index = next.indexOf(token);
      next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, ...releasedTokens);
      try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
  };
  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
    return next;
  });
  const expandProject = (projectKey: string) => {
    setCollapsedProjects((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current); next.delete(projectKey);
      try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
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
      try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
    void changeGroup({ type: "assign", key: drag.sessionKey, group: destinationKey === RECENT_KEY ? null : destinationKey }).catch(() => undefined);
  };
  const placeSidebarEntry = (token: string, beforeToken: string | null) => {
    const currentEntries = sidebarEntriesRef.current;
    if (beforeToken === token) return;
    const next = currentEntries.filter((entry) => entry !== token);
    const targetIndex = beforeToken === null ? -1 : next.indexOf(beforeToken);
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, token);
    setSidebarOrder(next);
    try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
  };
  const projectDetails = new Map<string, SessionSummary>();
  sessions.forEach((session) => { const key = physicalProjectKey(session); if (!projectDetails.has(key)) projectDetails.set(key, session); });
  const normalizedQuery = query.trim().toLowerCase();
  const customGroupsByKey = new Map(customGroups.map((group) => [group.id, group]));
  const visualProjectKey = (session: SessionSummary) => {
    const destination = storedGroups?.assignments[sessionKey(session)];
    if (!destination) return RECENT_KEY;
    const group = storedGroups?.groups.find((item) => item.id === destination);
    return group?.cwd && isTemporaryChatCwd(group.cwd) ? RECENT_KEY : destination;
  };
  const filtered = sessions.filter((session) => {
    if (!storedGroups) return false;
    if (!normalizedQuery) return true;
    const location = visualProjectKey(session);
    const groupName = location === RECENT_KEY ? RECENT_LABEL : storedGroups?.groups.find((group) => group.id === location)?.name ?? "";
    return `${session.name} ${session.project} ${projectName(session)} ${session.preview} ${session.hostName ?? session.hostId ?? "Local"} ${groupName}`.toLowerCase().includes(normalizedQuery);
  });
  const groupedSessions = filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[visualProjectKey(session)] ??= []).push(session); return result;
  }, {});
  const recentSessions = (groupedSessions[RECENT_KEY] ?? []).sort(recentSessionOrder);
  const physicalGroups = (storedGroups?.groups ?? []).filter((group) => group.cwd && !isTemporaryChatCwd(group.cwd)).map((group) => [group.id, group.name, group.hostId ?? "local", group.hostName ?? undefined, orderedSessions(group.id, groupedSessions[group.id] ?? [], sessionOrders)] as const);
  const customVisualGroups = customGroups.map((group) => [group.id, group.name, "", undefined, orderedSessions(group.id, groupedSessions[group.id] ?? [], sessionOrders)] as const);
  // Remember projects even while search or session placement hides them.
  const projectOrderKey = JSON.stringify((storedGroups?.groups ?? []).map((group) => groupLayoutToken(group.id)));
  useEffect(() => {
    const projectTokens: string[] = JSON.parse(projectOrderKey);
    setSidebarOrder((current) => {
      const added = projectTokens.filter((token) => !current.includes(token));
      if (!added.length) return current;
      const next = [...added, ...current];
      try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
  }, [projectOrderKey]);
  const groups = [
    ...customVisualGroups.filter(([, , , , projectSessions]) => !normalizedQuery || projectSessions.length > 0),
    ...physicalGroups.filter(([, , , , projectSessions]) => !normalizedQuery || projectSessions.length > 0),
    ...(recentSessions.length ? [[RECENT_KEY, RECENT_LABEL, "", undefined, recentSessions] as const] : []),
  ];
  groupedSessionsRef.current = new Map([[RECENT_KEY, recentSessions], ...groups.map(([key, , , , projectSessions]) => [key, projectSessions] as const)]);
  const defaultSidebarEntries = groups.map(([key]) => groupLayoutToken(key));
  const recentToken = groupLayoutToken(RECENT_KEY);
  const orderedSidebarEntries = (entries: string[]) => {
    const availableEntries = new Set(entries);
    const addedEntries = entries.filter((entry) => !sidebarOrder.includes(entry));
    return [...addedEntries.filter((entry) => entry !== recentToken), ...sidebarOrder.filter((entry) => availableEntries.has(entry)), ...addedEntries.filter((entry) => entry === recentToken)];
  };
  const sidebarEntries = orderedSidebarEntries(defaultSidebarEntries);
  const keyboardSidebarEntries = defaultSidebarEntries.includes(recentToken) ? sidebarEntries : orderedSidebarEntries([...defaultSidebarEntries, recentToken]);
  sidebarEntriesRef.current = sidebarEntries;
  const activeSession = sessions.find((session) => session.id === activeId && (session.hostId ?? "local") === activeHostId);
  const activeProjectKey = activeSession ? visualProjectKey(activeSession) : undefined;
  const moveSessionByKeyboard = (drag: DraggedSession, direction: -1 | 1, betweenGroups: boolean) => {
    const sourceSessions = groupedSessionsRef.current.get(drag.projectKey) ?? [];
    if (betweenGroups) {
      const destinationKeys = keyboardSidebarEntries.filter((token) => token.startsWith("group:")).map((token) => token.slice("group:".length));
      const sourceIndex = destinationKeys.indexOf(drag.projectKey); const destinationKey = destinationKeys[sourceIndex + direction];
      if (!destinationKey) return;
      moveSession(drag, destinationKey, groupedSessionsRef.current.get(destinationKey) ?? []); expandProject(destinationKey);
      return;
    }
    const sourceIndex = sourceSessions.findIndex((session) => sessionKey(session) === drag.sessionKey); const target = sourceSessions[sourceIndex + direction];
    if (!target) return;
    moveSession(drag, drag.projectKey, sourceSessions, sessionKey(target), direction < 0 ? "before" : "after");
  };
  const startMouseDrag = (event: React.MouseEvent<HTMLElement>, drag: DraggedItem) => {
    if (normalizedQuery || event.button !== 0) return;
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
    const updateDropTarget = (x: number, y: number, current: MouseDrag) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      let nextTarget: DropTarget | undefined;
      const sidebarDropZone = hit?.closest<HTMLElement>("[data-sidebar-drop-zone]");
      const sessionElement = hit?.closest<HTMLElement>(".session-item[data-session-key]");
      if (sidebarDropZone) {
        nextTarget = { projectKey: RECENT_KEY, sessionKey: "", edge: "after", layoutBefore: sidebarDropZone.dataset.sidebarEnd === "true" ? null : sidebarDropZone.dataset.sidebarBefore! };
      } else if (!("session" in current)) {
        const entryElement = hit?.closest<HTMLElement>("section[data-sidebar-token], .session-item[data-sidebar-token]");
        const token = entryElement?.dataset.sidebarToken;
        if (entryElement && token && token !== groupLayoutToken(current.projectKey)) {
          const bounds = entryElement.getBoundingClientRect();
          const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
          const index = sidebarEntriesRef.current.indexOf(token);
          nextTarget = { projectKey: RECENT_KEY, sessionKey: "", edge, layoutBefore: edge === "before" ? token : sidebarEntriesRef.current[index + 1] ?? null };
        }
      } else if (sessionElement && sessionElement.dataset.sessionKey !== current.sessionKey) {
        const bounds = sessionElement.getBoundingClientRect();
        const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
        const projectKey = sessionElement.dataset.projectKey!; const targetKey = sessionElement.dataset.sessionKey!;
        nextTarget = { projectKey, sessionKey: targetKey, edge };
      } else if (!sessionElement) {
        const projectElement = hit?.closest<HTMLElement>("[data-drop-project-key]");
        if (projectElement) nextTarget = { projectKey: projectElement.dataset.dropProjectKey!, sessionKey: "", edge: "after" };
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
      removeMouseListenersRef.current = () => {};
    };
  };
  const projectDragProps = (projectKey: string) => ({
    onMouseDown: (event: React.MouseEvent<HTMLElement>) => startMouseDrag(event, { projectKey }),
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (suppressClickRef.current === groupLayoutToken(projectKey)) { suppressClickRef.current = undefined; event.preventDefault(); return; }
      toggleProject(projectKey);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (normalizedQuery || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const entries = sidebarEntriesRef.current; const token = groupLayoutToken(projectKey); const index = entries.indexOf(token);
      const direction = event.key === "ArrowUp" ? -1 : 1;
      if (index + direction < 0 || index + direction >= entries.length) return;
      placeSidebarEntry(token, direction < 0 ? entries[index - 1] : entries[index + 2] ?? null);
    },
    "aria-description": !normalizedQuery ? "Drag to reorder. Press Alt plus Up or Down to reorder." : undefined,
    "aria-keyshortcuts": !normalizedQuery ? "Alt+ArrowUp Alt+ArrowDown" : undefined,
  });
  const renderSession = (session: SessionSummary, projectKey: string) => { const key = sessionKey(session); const running = runningSessions.has(key); const activity = unseenSessions.has(key) ? "New activity" : undefined; const accessibleActivity = running ? "Running" : activity; const target = dropTarget?.projectKey === projectKey && dropTarget.sessionKey === key ? dropTarget.edge : undefined; const drag = { projectKey, sessionKey: key, session }; return <div key={key} data-session-key={key} data-project-key={projectKey} className={`session-item ${!normalizedQuery ? "reorderable" : ""} ${activeId === session.id && (session.hostId ?? "local") === activeHostId ? "active" : ""} ${running ? "running" : activity ? "unseen" : ""} ${draggedSession?.sessionKey === key ? "dragging" : ""} ${target ? `drop-${target}` : ""}`} onContextMenu={(event) => { event.preventDefault(); const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined; setGroupMenu(undefined); setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190), returnFocus }); }}>
    <button className="session-main" aria-label={`${session.name}, ${projectKindLabel(session)}, ${formatApiCost(session.apiCost)}${accessibleActivity ? `, ${accessibleActivity}` : ""}`} aria-current={activeId === session.id && (session.hostId ?? "local") === activeHostId ? "page" : undefined} aria-description={!normalizedQuery ? "Press Alt plus Up or Down to reorder. Add Shift to move between groups." : undefined} aria-keyshortcuts={!normalizedQuery ? "Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined} title={session.name} onMouseDown={(event) => startMouseDrag(event, drag)} onKeyDown={(event) => { if (!normalizedQuery && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); moveSessionByKeyboard(drag, event.key === "ArrowUp" ? -1 : 1, event.shiftKey); } }} onClick={(event) => { if (suppressClickRef.current === sessionLayoutToken(key)) { suppressClickRef.current = undefined; event.preventDefault(); return; } onSelect(session); }}><span className="session-copy"><span className="session-title-row">{session.projectKind !== "no-repo" && <SessionProjectIcon session={session} />}<strong>{session.name}</strong><span className="session-api-cost" title="Would-be API cost">{formatApiCost(session.apiCost)}</span></span></span></button>
    <button className="session-archive" aria-label={`Archive ${session.name}`} title={`Archive ${session.name}`} onClick={() => onAction(session, "archive")}><Archive size={14} /></button>
  </div>; };
  const prepareWorktreeRemoval = async (id: string, name: string, group: SessionGroup) => {
    const cwd = group.cwd!; const hostId = group.hostId ?? "local";
    const hostSessions = sessions.filter((session) => (session.hostId ?? "local") === hostId);
    setGroupActionError(undefined);
    try {
      const [targetRoot, ...conversationRoots] = await gitWorktreeRoots([cwd, ...hostSessions.map((session) => session.cwd)], hostId);
      if (!targetRoot) throw new Error("Could not resolve the worktree directory");
      setRemovingWorktree({ id, name, cwd, hostId, conversationCount: conversationRoots.filter((root) => root === targetRoot).length });
    } catch (reason) { setGroupActionError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const groupsByToken = new Map(groups.map((group) => [groupLayoutToken(group[0]), group] as const));
  const activeMenu = groupMenu ?? menu;
  const groupDirectory = groupMenu ? storedGroups?.groups.find((group) => group.id === groupMenu.projectKey && group.cwd) : undefined;
  const groupDirectorySession = groupDirectory && sessions.find((session) => (session.hostId ?? "local") === (groupDirectory.hostId ?? "local") && session.cwd === groupDirectory.cwd);
  const isWorktreeGroup = groupDirectory?.projectKind === "worktree" || groupDirectorySession?.projectKind === "worktree";
  const menuItems = groupMenu ? [
    { label: "Open directory", Icon: FolderOpen, disabled: !groupDirectory, run: () => { if (groupDirectory?.cwd) { setGroupActionError(undefined); void openGroupDirectory(groupDirectory.cwd, groupDirectory.hostId ?? "local").catch((reason) => setGroupActionError(String(reason))); } } },
    { label: "Create worktree", Icon: GitBranch, disabled: !groupDirectory, run: () => { if (groupDirectory?.cwd) onCreateWorktree(groupDirectory.cwd, groupDirectory.hostId ?? "local"); } },
    ...(isWorktreeGroup && groupDirectory?.cwd ? [{ label: "Delete worktree…", Icon: Trash2, disabled: false, run: () => void prepareWorktreeRemoval(groupMenu.projectKey, groupMenu.label, groupDirectory) }] : []),
    { label: "Forget group", Icon: Trash2, disabled: false, run: () => setRemovingGroup({ id: groupMenu.projectKey, name: groupMenu.label }) },
  ] : menu ? actions.filter(([action]) => action !== "split" || menu.session.id !== activeId || (menu.session.hostId ?? "local") !== activeHostId).map(([action, Icon, label]) => ({ label, Icon, disabled: false, run: () => onAction(menu.session, action) })) : [];
  const renderDropZone = (beforeToken: string | null) => <div key={`drop-${beforeToken ?? "end"}`} data-sidebar-drop-zone data-sidebar-before={beforeToken ?? undefined} data-sidebar-end={beforeToken === null ? true : undefined} className={`sidebar-drop-zone ${dropTarget?.layoutBefore === beforeToken ? "active" : ""}`} />;
  return <aside className="session-panel">
    {removingGroup && <RemoveGroupDialog name={removingGroup.name} onCancel={() => setRemovingGroup(undefined)} onRemove={async () => { await removeGroup(removingGroup.id); setRemovingGroup(undefined); }} />}
    {removingWorktree && <RemoveWorktreeDialog name={removingWorktree.name} path={removingWorktree.cwd} conversationCount={removingWorktree.conversationCount} onCancel={() => setRemovingWorktree(undefined)} onRemove={async (deleteBranch) => {
      await onDeleteWorktree(removingWorktree.cwd, removingWorktree.hostId, deleteBranch);
      try { await removeGroup(removingWorktree.id); }
      catch (reason) { setGroupActionError(`Worktree deleted, but its sidebar group could not be forgotten: ${String(reason)}`); }
      setRemovingWorktree(undefined);
    }} />}
    <label className="search"><Search size={15} /><input ref={searchRef} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl G</kbd></label>
    <div ref={sessionScrollRef} className="session-scroll">
      {(groupStorageError || groupActionError) && <p className="group-error" role="alert">{groupStorageError || groupActionError}</p>}
      {!storedGroups && !groupStorageError && <p className="empty-small">Loading groups…</p>}
      {newGroupName !== undefined && !editingGroupId && <section className="project custom-group-draft"><div className="project-label"><input ref={groupNameRef} disabled={groupSaving} aria-label="New session group name" aria-invalid={Boolean(groupDraftError)} aria-describedby={groupDraftError ? "new-group-error" : undefined} placeholder="Group name" value={newGroupName} onChange={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} /></div>{groupDraftError && <small id="new-group-error" className="group-error">{groupDraftError}</small>}</section>}
      {sidebarEntries.flatMap((token) => { const group = groupsByToken.get(token); if (!group) return []; const [projectKey, project, hostId, hostName, projectSessions] = group; const label = !hostId || hostId === "local" ? project : `${hostName ?? hostId} / ${project}`; const collapsed = !normalizedQuery && collapsedProjects.has(projectKey); const groupId = disclosureId(projectKey); return [renderDropZone(token), <section data-sidebar-token={token} className={`project ${!normalizedQuery ? "reorderable" : ""} ${draggedProject === projectKey ? "dragging" : ""} ${dropTarget?.projectKey === projectKey && !dropTarget.sessionKey && dropTarget.layoutBefore === undefined ? "drop-project" : ""}`} key={projectKey}>
        <div className="project-heading" data-drop-project-key={projectKey}>
          {customGroupsByKey.has(projectKey) && editingGroupId === customGroupsByKey.get(projectKey)?.id ? <div className="project-label"><input ref={groupNameRef} disabled={groupSaving} aria-label="Rename session group" aria-invalid={Boolean(groupDraftError)} value={newGroupName ?? ""} onChange={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} />{groupDraftError && <small className="group-error">{groupDraftError}</small>}</div> : <>
            <button className="project-label" disabled={Boolean(normalizedQuery)} aria-expanded={!collapsed} aria-controls={groupId} {...projectDragProps(projectKey)}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} />{projectDetails.get(projectKey)?.projectKind === "no-repo" && <Folder size={14} aria-hidden="true" />}<span className={projectKey === activeProjectKey ? "active" : undefined}>{label}</span></button>
            {projectKey !== RECENT_KEY && <div className="project-actions">
              {customGroupsByKey.has(projectKey) && <button aria-label={`Rename group ${label}`} title="Rename group" onClick={() => editGroup(customGroupsByKey.get(projectKey)!)}><Pencil size={12} /></button>}
              <button aria-label={`New chat in ${label}`} title="New chat in group" onClick={() => {
                const destination = storedGroups?.groups.find((item) => item.id === projectKey);
                if (!destination) return;
                expandProject(projectKey);
                onNewChat(destination);
              }}><MessageSquarePlus size={14} /></button>
              <button aria-label={`Group actions for ${label}`} title="Group actions" aria-haspopup="menu" aria-expanded={groupMenu?.projectKey === projectKey} onClick={(event) => {
                event.stopPropagation();
                if (groupMenu?.projectKey === projectKey) { closeMenu(true); return; }
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenu(undefined);
                setGroupMenu({ projectKey, label, x: Math.max(8, Math.min(bounds.right - 188, window.innerWidth - 196)), y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 84)), returnFocus: event.currentTarget });
              }}><Ellipsis size={14} /></button>
            </div>}
          </>}
        </div>
        <div id={groupId} hidden={collapsed}>{projectSessions.map((session) => renderSession(session, projectKey))}</div>
      </section>]; })}
      {sidebarEntries.length > 0 && renderDropZone(null)}
      {storedGroups && !filtered.length && <div className="empty-small">{normalizedQuery ? `No conversations match “${query.trim()}”.` : "No conversations yet."}</div>}
    </div>
    {activeMenu && <div ref={menuRef} className="conversation-menu session-context-menu" role="menu" aria-label={`${groupMenu?.label ?? menu?.session.name} actions`} style={{ left: activeMenu.x, top: activeMenu.y }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    }}>{menuItems.map(({ label, Icon, disabled, run }) => <button key={label} role="menuitem" disabled={disabled} title={disabled ? "Custom groups have no directory" : undefined} onClick={() => { closeMenu(true); run(); }}><Icon size={14} />{label}</button>)}</div>}
  </aside>;
}
