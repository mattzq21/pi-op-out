import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, Columns2, CopyPlus, FolderOpen, Pencil, Search, Trash2 } from "lucide-react";
import type { SessionSummary } from "../types";

export type SessionAction = "split" | "rename" | "clone" | "open-directory" | "archive";
interface Props { sessions: SessionSummary[]; activeId?: string; activeHostId?: string; runningSessions?: ReadonlySet<string>; unseenSessions?: ReadonlySet<string>; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onAction: (session: SessionSummary, action: SessionAction) => void; createGroupRequest?: number; }
interface CustomGroup { id: string; name: string; }
interface DraggedSession { projectKey: string; sessionKey: string; session: SessionSummary; }
interface DropTarget { projectKey: string; sessionKey: string; edge: "before" | "after"; layoutBefore?: string | null; }
interface MouseDrag extends DraggedSession { startX: number; startY: number; active: boolean; }

const actions = [
  ["split", Columns2, "Split pane"], ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["open-directory", FolderOpen, "Open project directory"]
] as const;
const COLLAPSED_PROJECTS_KEY = "pi-desktop-collapsed-projects";
const SESSION_ORDERS_KEY = "pi-desktop-session-orders";
const SESSION_LOCATIONS_KEY = "pi-desktop-session-locations";
const SIDEBAR_ORDER_KEY = "pi-desktop-sidebar-order";
const CUSTOM_GROUPS_KEY = "pi-desktop-custom-session-groups";
const CUSTOM_GROUP_PREFIX = "__pi-desktop-custom-group__:";
const UNGROUPED_KEY = "__pi-desktop-ungrouped__";
const sidebarCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function stableSessionOrder(left: SessionSummary, right: SessionSummary) {
  return sidebarCollator.compare(left.name, right.name) || sidebarCollator.compare(left.id, right.id);
}

function savedCollapsedProjects() {
  try { const value = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); }
  catch { return new Set<string>(); }
}

function savedSessionOrders() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_ORDERS_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")));
  } catch { return {}; }
}

function savedSessionLocations() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_LOCATIONS_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function savedCustomGroups() {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_GROUPS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is CustomGroup => Boolean(item) && typeof item.id === "string" && typeof item.name === "string" && Boolean(item.name.trim())) : [];
  } catch { return []; }
}

function savedSidebarOrder() {
  try { const value = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) || "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

function sessionKey(session: SessionSummary) { return `${session.hostId ?? "local"}:${session.id}`; }
function physicalProjectKey(session: SessionSummary) { return `${session.hostId ?? "local"}:${session.cwd}`; }
function canPlaceSessionIn(session: SessionSummary, projectKey: string) { return projectKey === UNGROUPED_KEY || projectKey.startsWith(CUSTOM_GROUP_PREFIX) || projectKey === physicalProjectKey(session); }
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

export function SessionPanel({ sessions, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction, createGroupRequest = 0 }: Props) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number; returnFocus?: HTMLElement }>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(savedCollapsedProjects);
  const [sessionOrders, setSessionOrders] = useState<Record<string, string[]>>(savedSessionOrders);
  const [sessionLocations, setSessionLocations] = useState<Record<string, string>>(savedSessionLocations);
  const [customGroups, setCustomGroups] = useState<CustomGroup[]>(savedCustomGroups);
  const [sidebarOrder, setSidebarOrder] = useState<string[]>(savedSidebarOrder);
  const [newGroupName, setNewGroupName] = useState<string>();
  const [editingGroupId, setEditingGroupId] = useState<string>();
  const [groupDraftError, setGroupDraftError] = useState<string>();
  const [draggedSession, setDraggedSession] = useState<DraggedSession>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const groupNameRef = useRef<HTMLInputElement>(null);
  const groupDraftActive = useRef(false);
  const lastCreateGroupRequestRef = useRef(createGroupRequest);
  const mouseDragRef = useRef<MouseDrag | undefined>(undefined);
  const mouseDropTargetRef = useRef<DropTarget | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const sessionScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const dragPointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const groupedSessionsRef = useRef<Map<string, SessionSummary[]>>(new Map());
  const sidebarEntriesRef = useRef<string[]>([]);
  const removeMouseListenersRef = useRef<() => void>(() => {});
  const closeMenu = (restoreFocus = false) => { const target = menu?.returnFocus; setMenu(undefined); if (restoreFocus) requestAnimationFrame(() => target?.focus()); };
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    const close = () => closeMenu();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(true); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    const scroll = sessionScrollRef.current; scroll?.addEventListener("scroll", close, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); scroll?.removeEventListener("scroll", close); };
  }, [menu]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    if (createGroupRequest === lastCreateGroupRequestRef.current) return;
    lastCreateGroupRequestRef.current = createGroupRequest;
    groupDraftActive.current = true; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName("");
    const frame = requestAnimationFrame(() => groupNameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [createGroupRequest]);
  useEffect(() => () => { removeMouseListenersRef.current(); if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current); }, []);
  useEffect(() => { if (menu && !sessions.some((session) => sessionKey(session) === sessionKey(menu.session))) closeMenu(); }, [menu, sessions]);
  const groupNameTaken = (name: string, excludedId?: string) => {
    const normalized = name.trim();
    return sessions.some((session) => { const label = !session.hostId || session.hostId === "local" ? session.project : `${session.hostName ?? session.hostId} / ${session.project}`; return sidebarCollator.compare(label.trim(), normalized) === 0; })
      || customGroups.some((group) => group.id !== excludedId && sidebarCollator.compare(group.name.trim(), normalized) === 0);
  };
  const finishGroup = (cancel = false) => {
    if (!groupDraftActive.current) return;
    const name = newGroupName?.trim();
    if (cancel) { groupDraftActive.current = false; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName(undefined); return; }
    if (!name) { setGroupDraftError("Enter a group name."); return; }
    if (groupNameTaken(name, editingGroupId)) { setGroupDraftError("A project or group already uses that name."); return; }
    groupDraftActive.current = false; setGroupDraftError(undefined); setNewGroupName(undefined);
    setCustomGroups((current) => {
      const next = editingGroupId ? current.map((group) => group.id === editingGroupId ? { ...group, name } : group) : [...current, { id: crypto.randomUUID(), name }];
      try { localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
    setEditingGroupId(undefined);
  };
  const editGroup = (group: CustomGroup) => { groupDraftActive.current = true; setEditingGroupId(group.id); setGroupDraftError(undefined); setNewGroupName(group.name); requestAnimationFrame(() => groupNameRef.current?.select()); };
  const deleteGroup = (group: CustomGroup) => {
    const projectKey = `${CUSTOM_GROUP_PREFIX}${group.id}`;
    setCustomGroups((current) => { const next = current.filter((item) => item.id !== group.id); try { localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ } return next; });
    setSessionLocations((current) => { const next = Object.fromEntries(Object.entries(current).filter(([, location]) => location !== projectKey)); try { localStorage.setItem(SESSION_LOCATIONS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ } return next; });
    setSessionOrders((current) => { const next = { ...current }; delete next[projectKey]; try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ } return next; });
    setCollapsedProjects((current) => { const next = new Set(current); next.delete(projectKey); try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ } return next; });
    setSidebarOrder((current) => { const next = current.filter((token) => token !== groupLayoutToken(projectKey)); try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ } return next; });
  };
  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
    return next;
  });
  const expandProject = (projectKey: string) => {
    if (projectKey === UNGROUPED_KEY) return;
    setCollapsedProjects((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current); next.delete(projectKey);
      try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
      return next;
    });
  };
  const moveSession = (drag: DraggedSession, destinationKey: string, destinationSessions: SessionSummary[], targetKey?: string, edge: "before" | "after" = "after") => {
    if (!canPlaceSessionIn(drag.session, destinationKey)) return;
    if (drag.projectKey === destinationKey && drag.sessionKey === targetKey) return;
    const nextOrder = destinationSessions.map(sessionKey).filter((key) => key !== drag.sessionKey);
    const targetIndex = targetKey ? nextOrder.indexOf(targetKey) : -1;
    nextOrder.splice(targetIndex < 0 ? nextOrder.length : targetIndex + (edge === "after" ? 1 : 0), 0, drag.sessionKey);
    setSessionOrders((current) => {
      const next = { ...current, [destinationKey]: nextOrder };
      try { localStorage.setItem(SESSION_ORDERS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
    setSessionLocations((current) => {
      const next = { ...current };
      if (destinationKey === physicalProjectKey(drag.session)) delete next[drag.sessionKey];
      else next[drag.sessionKey] = destinationKey;
      try { localStorage.setItem(SESSION_LOCATIONS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
  };
  const placeLooseSession = (key: string, beforeToken: string | null) => {
    const token = sessionLayoutToken(key);
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
  const customGroupsByKey = new Map(customGroups.map((group) => [`${CUSTOM_GROUP_PREFIX}${group.id}`, group]));
  const customGroupKeys = new Set(customGroups.map((group) => `${CUSTOM_GROUP_PREFIX}${group.id}`));
  const visualProjectKey = (session: SessionSummary) => {
    const savedLocation = sessionLocations[sessionKey(session)];
    return savedLocation === UNGROUPED_KEY || (typeof savedLocation === "string" && (projectDetails.has(savedLocation) || customGroupKeys.has(savedLocation))) ? savedLocation : physicalProjectKey(session);
  };
  const filtered = sessions.filter((session) => {
    if (!normalizedQuery) return true;
    const groupName = customGroupsByKey.get(visualProjectKey(session))?.name ?? "";
    return `${session.name} ${session.project} ${session.preview} ${session.hostName ?? session.hostId ?? "Local"} ${groupName}`.toLowerCase().includes(normalizedQuery);
  });
  const groupedSessions = filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[visualProjectKey(session)] ??= []).push(session); return result;
  }, {});
  const ungroupedSessions = orderedSessions(UNGROUPED_KEY, groupedSessions[UNGROUPED_KEY] ?? [], sessionOrders);
  const physicalGroups = [...projectDetails.entries()].map(([key, details]) => [key, details.project, details.hostId ?? "local", details.hostName, orderedSessions(key, groupedSessions[key] ?? [], sessionOrders)] as const)
    .filter(([, , , , projectSessions]) => projectSessions.length > 0 || Boolean(draggedSession))
    .sort(([, leftProject, leftHost, leftHostName], [, rightProject, rightHost, rightHostName]) => sidebarCollator.compare(leftHostName ?? leftHost, rightHostName ?? rightHost) || sidebarCollator.compare(leftProject, rightProject));
  const customVisualGroups = customGroups.map((group) => { const key = `${CUSTOM_GROUP_PREFIX}${group.id}`; return [key, group.name, "", undefined, orderedSessions(key, groupedSessions[key] ?? [], sessionOrders)] as const; })
    .filter(([, , , , projectSessions]) => !normalizedQuery || projectSessions.length > 0);
  const groups = [...customVisualGroups, ...physicalGroups];
  groupedSessionsRef.current = new Map([[UNGROUPED_KEY, ungroupedSessions], ...groups.map(([key, , , , projectSessions]) => [key, projectSessions] as const)]);
  const defaultSidebarEntries = [...ungroupedSessions.map((session) => sessionLayoutToken(sessionKey(session))), ...groups.map(([key]) => groupLayoutToken(key))];
  const availableSidebarEntries = new Set(defaultSidebarEntries);
  const sidebarEntries = [...sidebarOrder.filter((entry) => availableSidebarEntries.has(entry)), ...defaultSidebarEntries.filter((entry) => !sidebarOrder.includes(entry))];
  sidebarEntriesRef.current = sidebarEntries;
  const activeSession = sessions.find((session) => session.id === activeId && (session.hostId ?? "local") === activeHostId);
  const activeProjectKey = activeSession ? visualProjectKey(activeSession) : undefined;
  const moveSessionByKeyboard = (drag: DraggedSession, direction: -1 | 1, betweenGroups: boolean) => {
    const sourceSessions = groupedSessionsRef.current.get(drag.projectKey) ?? [];
    if (betweenGroups) {
      const destinationKeys = [UNGROUPED_KEY, ...groups.map(([key]) => key)].filter((key) => canPlaceSessionIn(drag.session, key));
      const sourceIndex = destinationKeys.indexOf(drag.projectKey); const destinationKey = destinationKeys[sourceIndex + direction];
      if (!destinationKey) return;
      moveSession(drag, destinationKey, groupedSessionsRef.current.get(destinationKey) ?? []); expandProject(destinationKey);
      return;
    }
    const sourceIndex = sourceSessions.findIndex((session) => sessionKey(session) === drag.sessionKey); const target = sourceSessions[sourceIndex + direction];
    if (!target) return;
    moveSession(drag, drag.projectKey, sourceSessions, sessionKey(target), direction < 0 ? "before" : "after");
  };
  const startMouseDrag = (event: React.MouseEvent<HTMLElement>, drag: DraggedSession) => {
    if (normalizedQuery || event.button !== 0) return;
    removeMouseListenersRef.current();
    const mouseDrag: MouseDrag = { ...drag, startX: event.clientX, startY: event.clientY, active: false };
    mouseDragRef.current = mouseDrag;
    const clear = () => {
      removeMouseListenersRef.current();
      mouseDragRef.current = undefined;
      mouseDropTargetRef.current = undefined;
      setDraggedSession(undefined);
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
        nextTarget = { projectKey: UNGROUPED_KEY, sessionKey: "", edge: "after", layoutBefore: sidebarDropZone.dataset.sidebarEnd === "true" ? null : sidebarDropZone.dataset.sidebarBefore! };
      } else if (sessionElement && sessionElement.dataset.sessionKey !== current.sessionKey) {
        const bounds = sessionElement.getBoundingClientRect();
        const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
        const projectKey = sessionElement.dataset.projectKey!; const targetKey = sessionElement.dataset.sessionKey!;
        if (!canPlaceSessionIn(current.session, projectKey)) nextTarget = undefined;
        else if (projectKey === UNGROUPED_KEY) {
          const token = sessionLayoutToken(targetKey); const index = sidebarEntriesRef.current.indexOf(token);
          nextTarget = { projectKey, sessionKey: targetKey, edge, layoutBefore: edge === "before" ? token : sidebarEntriesRef.current[index + 1] ?? null };
        } else nextTarget = { projectKey, sessionKey: targetKey, edge };
      } else if (!sessionElement) {
        const projectElement = hit?.closest<HTMLElement>("[data-drop-project-key]");
        if (projectElement && canPlaceSessionIn(current.session, projectElement.dataset.dropProjectKey!)) nextTarget = { projectKey: projectElement.dataset.dropProjectKey!, sessionKey: "", edge: "after" };
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
      if (!current.active) { current.active = true; setDraggedSession(current); }
      mouseEvent.preventDefault(); dragPointerRef.current = { x: mouseEvent.clientX, y: mouseEvent.clientY };
      updateDropTarget(mouseEvent.clientX, mouseEvent.clientY, current);
      if (autoScrollFrameRef.current === undefined) autoScrollFrameRef.current = requestAnimationFrame(autoScroll);
    };
    const finish = (mouseEvent: MouseEvent) => {
      const current = mouseDragRef.current;
      if (!current) return;
      if (current.active) {
        const releasedSession = mouseEvent.target instanceof Element ? mouseEvent.target.closest<HTMLElement>(".session-item[data-session-key]")?.dataset.sessionKey : undefined;
        if (releasedSession === current.sessionKey) {
          suppressClickRef.current = current.sessionKey;
          window.setTimeout(() => { if (suppressClickRef.current === current.sessionKey) suppressClickRef.current = undefined; }, 0);
        }
        const target = mouseDropTargetRef.current;
        if (target) {
          moveSession(current, target.projectKey, groupedSessionsRef.current.get(target.projectKey) ?? [], target.sessionKey || undefined, target.edge);
          if (target.layoutBefore !== undefined) placeLooseSession(current.sessionKey, target.layoutBefore);
          expandProject(target.projectKey);
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
  const nameCounts = sessions.reduce((counts, session) => { const key = `${visualProjectKey(session)}:${session.name}`; counts.set(key, (counts.get(key) ?? 0) + 1); return counts; }, new Map<string, number>());
  const duplicateNames = new Set([...nameCounts].filter(([, count]) => count > 1).map(([key]) => key));
  const renderSession = (session: SessionSummary, projectKey: string) => { const key = sessionKey(session); const running = runningSessions.has(key); const activity = unseenSessions.has(key) ? "New activity" : undefined; const accessibleActivity = running ? "Running" : activity; const duplicateName = duplicateNames.has(`${projectKey}:${session.name}`); const location = session.hostId && session.hostId !== "local" ? `${session.hostName ?? session.hostId} / ${session.project}` : session.project; const discriminator = `${location}${session.preview.trim() ? ` · ${session.preview.trim()}` : ""}`; const target = dropTarget?.projectKey === projectKey && dropTarget.sessionKey === key ? dropTarget.edge : undefined; const drag = { projectKey, sessionKey: key, session }; return <div key={key} data-session-key={key} data-project-key={projectKey} className={`session-item ${!normalizedQuery ? "reorderable" : ""} ${activeId === session.id && (session.hostId ?? "local") === activeHostId ? "active" : ""} ${running ? "running" : activity ? "unseen" : ""} ${draggedSession?.sessionKey === key ? "dragging" : ""} ${target ? `drop-${target}` : ""}`} onContextMenu={(event) => { event.preventDefault(); const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined; setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190), returnFocus }); }}>
    <button className="session-main" aria-label={`${session.name}, ${duplicateName ? `${discriminator}, ` : ""}${formatApiCost(session.apiCost)}${accessibleActivity ? `, ${accessibleActivity}` : ""}`} aria-current={activeId === session.id && (session.hostId ?? "local") === activeHostId ? "page" : undefined} aria-description={!normalizedQuery ? "Press Alt plus Up or Down to reorder. Add Shift to move between groups." : undefined} aria-keyshortcuts={!normalizedQuery ? "Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined} title={session.name} onMouseDown={(event) => startMouseDrag(event, drag)} onKeyDown={(event) => { if (!normalizedQuery && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); moveSessionByKeyboard(drag, event.key === "ArrowUp" ? -1 : 1, event.shiftKey); } }} onClick={(event) => { if (suppressClickRef.current === key) { suppressClickRef.current = undefined; event.preventDefault(); return; } onSelect(session); }}><span className="session-copy"><span className="session-title-row"><strong>{session.name}</strong>{activity && !running && <small className="session-activity">{activity}</small>}<span className="session-api-cost" title="Would-be API cost">{formatApiCost(session.apiCost)}</span></span>{duplicateName && <small className="session-preview">{discriminator}</small>}</span></button>
    <button className="session-archive" aria-label={`Archive ${session.name}`} title={`Archive ${session.name}`} onClick={() => onAction(session, "archive")}><Archive size={14} /></button>
  </div>; };
  const groupsByToken = new Map(groups.map((group) => [groupLayoutToken(group[0]), group] as const));
  const looseSessionsByToken = new Map(ungroupedSessions.map((session) => [sessionLayoutToken(sessionKey(session)), session] as const));
  const renderDropZone = (beforeToken: string | null) => <div key={`drop-${beforeToken ?? "end"}`} data-sidebar-drop-zone data-sidebar-before={beforeToken ?? undefined} data-sidebar-end={beforeToken === null ? true : undefined} className={`sidebar-drop-zone ${dropTarget?.layoutBefore === beforeToken ? "active" : ""}`} />;
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input ref={searchRef} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl G</kbd></label>
    <div ref={sessionScrollRef} className="session-scroll">
      {newGroupName !== undefined && !editingGroupId && <section className="project custom-group-draft"><div className="project-label"><input ref={groupNameRef} aria-label="New session group name" aria-invalid={Boolean(groupDraftError)} aria-describedby={groupDraftError ? "new-group-error" : undefined} placeholder="Group name" value={newGroupName} onChange={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} /></div>{groupDraftError && <small id="new-group-error" className="group-error">{groupDraftError}</small>}</section>}
      {sidebarEntries.flatMap((token) => { const looseSession = looseSessionsByToken.get(token); const group = groupsByToken.get(token); if (looseSession) return [renderDropZone(token), renderSession(looseSession, UNGROUPED_KEY)]; if (!group) return []; const [projectKey, project, hostId, hostName, projectSessions] = group; const label = !hostId || hostId === "local" ? project : `${hostName ?? hostId} / ${project}`; const collapsed = !normalizedQuery && collapsedProjects.has(projectKey); const groupId = disclosureId(projectKey); return [renderDropZone(token), <section className={`project ${dropTarget?.projectKey === projectKey && !dropTarget.sessionKey && dropTarget.layoutBefore === undefined ? "drop-project" : ""}`} key={projectKey}>
        {projectKey.startsWith(CUSTOM_GROUP_PREFIX) ? <div className="project-heading" data-drop-project-key={projectKey}>{editingGroupId === projectKey.slice(CUSTOM_GROUP_PREFIX.length) ? <div className="project-label"><input ref={groupNameRef} aria-label="Rename session group" aria-invalid={Boolean(groupDraftError)} value={newGroupName ?? ""} onChange={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} />{groupDraftError && <small className="group-error">{groupDraftError}</small>}</div> : <><button className="project-label" disabled={Boolean(normalizedQuery)} aria-expanded={!collapsed} aria-controls={groupId} onClick={() => toggleProject(projectKey)}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} /><span className={projectKey === activeProjectKey ? "active" : undefined}>{label}</span></button><div className="project-actions"><button aria-label={`Rename group ${label}`} title="Rename group" onClick={() => editGroup(customGroupsByKey.get(projectKey)!)}><Pencil size={12} /></button><button aria-label={`Delete group ${label}`} title="Delete group" onClick={() => deleteGroup(customGroupsByKey.get(projectKey)!)}><Trash2 size={12} /></button></div></>}</div> : <button className="project-label" data-drop-project-key={projectKey} disabled={Boolean(normalizedQuery)} aria-expanded={!collapsed} aria-controls={groupId} onClick={() => toggleProject(projectKey)}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} /><span className={projectKey === activeProjectKey ? "active" : undefined}>{label}</span></button>}
        <div id={groupId} hidden={collapsed}>{projectSessions.map((session) => renderSession(session, projectKey))}</div>
      </section>]; })}
      {sidebarEntries.length > 0 && renderDropZone(null)}
      {!filtered.length && <div className="empty-small">{normalizedQuery ? `No conversations match “${query.trim()}”.` : "No conversations yet."}</div>}
    </div>
    {menu && <div ref={menuRef} className="conversation-menu session-context-menu" role="menu" aria-label={`${menu.session.name} actions`} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    }}>{actions.filter(([action]) => action !== "split" || menu.session.id !== activeId || (menu.session.hostId ?? "local") !== activeHostId).map(([action, Icon, label]) => <button key={action} role="menuitem" onClick={() => { setMenu(undefined); onAction(menu.session, action); }}><Icon size={14} />{label}</button>)}</div>}
  </aside>;
}
