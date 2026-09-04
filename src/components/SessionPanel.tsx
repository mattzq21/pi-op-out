import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, Columns2, CopyPlus, FolderOpen, Pencil, Search } from "lucide-react";
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
function sessionLayoutToken(key: string) { return `session:${key}`; }
function groupLayoutToken(key: string) { return `group:${key}`; }

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
  const [draggedSession, setDraggedSession] = useState<DraggedSession>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const menuRef = useRef<HTMLDivElement>(null);
  const groupNameRef = useRef<HTMLInputElement>(null);
  const groupDraftActive = useRef(false);
  const mouseDragRef = useRef<MouseDrag | undefined>(undefined);
  const mouseDropTargetRef = useRef<DropTarget | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
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
    return () => { cancelAnimationFrame(frame); window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); };
  }, [menu]);
  useEffect(() => {
    if (!createGroupRequest) return;
    groupDraftActive.current = true; setNewGroupName("");
    const frame = requestAnimationFrame(() => groupNameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [createGroupRequest]);
  useEffect(() => () => removeMouseListenersRef.current(), []);
  const finishGroup = (cancel = false) => {
    if (!groupDraftActive.current) return;
    groupDraftActive.current = false; const name = newGroupName?.trim(); setNewGroupName(undefined);
    if (cancel || !name) return;
    setCustomGroups((current) => {
      const next = [...current, { id: crypto.randomUUID(), name }];
      try { localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(next)); } catch { /* Persistence is best-effort. */ }
      return next;
    });
  };
  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
    return next;
  });
  const moveSession = (drag: DraggedSession, destinationKey: string, destinationSessions: SessionSummary[], targetKey?: string, edge: "before" | "after" = "after") => {
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
  const filtered = sessions.filter((session) => `${session.name} ${session.project} ${session.preview}`.toLowerCase().includes(query.toLowerCase()));
  const projectDetails = new Map<string, SessionSummary>();
  sessions.forEach((session) => { const key = physicalProjectKey(session); if (!projectDetails.has(key)) projectDetails.set(key, session); });
  const customGroupKeys = new Set(customGroups.map((group) => `${CUSTOM_GROUP_PREFIX}${group.id}`));
  const visualProjectKey = (session: SessionSummary) => {
    const savedLocation = sessionLocations[sessionKey(session)];
    return savedLocation === UNGROUPED_KEY || (typeof savedLocation === "string" && (projectDetails.has(savedLocation) || customGroupKeys.has(savedLocation))) ? savedLocation : physicalProjectKey(session);
  };
  const groupedSessions = filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[visualProjectKey(session)] ??= []).push(session); return result;
  }, {});
  const ungroupedSessions = orderedSessions(UNGROUPED_KEY, groupedSessions[UNGROUPED_KEY] ?? [], sessionOrders);
  const physicalGroups = [...projectDetails.entries()].map(([key, details]) => [key, details.project, details.hostId ?? "local", details.hostName, orderedSessions(key, groupedSessions[key] ?? [], sessionOrders)] as const)
    .filter(([, , , , projectSessions]) => projectSessions.length > 0 || Boolean(draggedSession))
    .sort(([, leftProject, leftHost, leftHostName], [, rightProject, rightHost, rightHostName]) => sidebarCollator.compare(leftHostName ?? leftHost, rightHostName ?? rightHost) || sidebarCollator.compare(leftProject, rightProject));
  const customVisualGroups = customGroups.map((group) => { const key = `${CUSTOM_GROUP_PREFIX}${group.id}`; return [key, group.name, "", undefined, orderedSessions(key, groupedSessions[key] ?? [], sessionOrders)] as const; });
  const groups = [...customVisualGroups, ...physicalGroups];
  groupedSessionsRef.current = new Map([[UNGROUPED_KEY, ungroupedSessions], ...groups.map(([key, , , , projectSessions]) => [key, projectSessions] as const)]);
  const defaultSidebarEntries = [...ungroupedSessions.map((session) => sessionLayoutToken(sessionKey(session))), ...groups.map(([key]) => groupLayoutToken(key))];
  const availableSidebarEntries = new Set(defaultSidebarEntries);
  const sidebarEntries = [...sidebarOrder.filter((entry) => availableSidebarEntries.has(entry)), ...defaultSidebarEntries.filter((entry) => !sidebarOrder.includes(entry))];
  sidebarEntriesRef.current = sidebarEntries;
  const activeSession = sessions.find((session) => session.id === activeId && (session.hostId ?? "local") === activeHostId);
  const activeProjectKey = activeSession ? visualProjectKey(activeSession) : undefined;
  const startMouseDrag = (event: React.MouseEvent<HTMLElement>, drag: DraggedSession) => {
    if (query || event.button !== 0) return;
    removeMouseListenersRef.current();
    const mouseDrag: MouseDrag = { ...drag, startX: event.clientX, startY: event.clientY, active: false };
    mouseDragRef.current = mouseDrag;
    const clear = () => {
      removeMouseListenersRef.current();
      mouseDragRef.current = undefined;
      mouseDropTargetRef.current = undefined;
      setDraggedSession(undefined);
      setDropTarget(undefined);
    };
    const move = (mouseEvent: MouseEvent) => {
      const current = mouseDragRef.current;
      if (!current) return;
      if (!current.active && Math.hypot(mouseEvent.clientX - current.startX, mouseEvent.clientY - current.startY) < 5) return;
      if (!current.active) { current.active = true; setDraggedSession(current); }
      mouseEvent.preventDefault();
      const hit = document.elementFromPoint(mouseEvent.clientX, mouseEvent.clientY) as HTMLElement | null;
      let nextTarget: DropTarget | undefined;
      const sidebarDropZone = hit?.closest<HTMLElement>("[data-sidebar-drop-zone]");
      const sessionElement = hit?.closest<HTMLElement>(".session-item[data-session-key]");
      if (sidebarDropZone) {
        nextTarget = { projectKey: UNGROUPED_KEY, sessionKey: "", edge: "after", layoutBefore: sidebarDropZone.dataset.sidebarEnd === "true" ? null : sidebarDropZone.dataset.sidebarBefore! };
      } else if (sessionElement && sessionElement.dataset.sessionKey !== current.sessionKey) {
        const bounds = sessionElement.getBoundingClientRect();
        const edge = mouseEvent.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
        const projectKey = sessionElement.dataset.projectKey!; const targetKey = sessionElement.dataset.sessionKey!;
        if (projectKey === UNGROUPED_KEY) {
          const token = sessionLayoutToken(targetKey); const index = sidebarEntriesRef.current.indexOf(token);
          nextTarget = { projectKey, sessionKey: targetKey, edge, layoutBefore: edge === "before" ? token : sidebarEntriesRef.current[index + 1] ?? null };
        } else nextTarget = { projectKey, sessionKey: targetKey, edge };
      } else if (!sessionElement) {
        const projectElement = hit?.closest<HTMLElement>("[data-drop-project-key]");
        if (projectElement) nextTarget = { projectKey: projectElement.dataset.dropProjectKey!, sessionKey: "", edge: "after" };
      }
      mouseDropTargetRef.current = nextTarget;
      setDropTarget(nextTarget);
    };
    const finish = () => {
      const current = mouseDragRef.current;
      if (!current) return;
      if (current.active) {
        suppressClickRef.current = current.sessionKey;
        const target = mouseDropTargetRef.current;
        if (target) {
          moveSession(current, target.projectKey, groupedSessionsRef.current.get(target.projectKey) ?? [], target.sessionKey || undefined, target.edge);
          if (target.layoutBefore !== undefined) placeLooseSession(current.sessionKey, target.layoutBefore);
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
  const renderSession = (session: SessionSummary, projectKey: string) => { const key = sessionKey(session); const running = runningSessions.has(key); const activity = unseenSessions.has(key) ? "New activity" : undefined; const accessibleActivity = running ? "Running" : activity; const target = dropTarget?.projectKey === projectKey && dropTarget.sessionKey === key ? dropTarget.edge : undefined; return <div key={key} data-session-key={key} data-project-key={projectKey} className={`session-item ${!query ? "reorderable" : ""} ${activeId === session.id && (session.hostId ?? "local") === activeHostId ? "active" : ""} ${running ? "running" : activity ? "unseen" : ""} ${draggedSession?.sessionKey === key ? "dragging" : ""} ${target ? `drop-${target}` : ""}`} onContextMenu={(event) => { event.preventDefault(); const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined; setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190), returnFocus }); }}>
    <button className="session-main" aria-label={`${session.name}, ${formatApiCost(session.apiCost)}${accessibleActivity ? `, ${accessibleActivity}` : ""}`} onMouseDown={(event) => startMouseDrag(event, { projectKey, sessionKey: key, session })} onClick={(event) => { if (suppressClickRef.current === key) { suppressClickRef.current = undefined; event.preventDefault(); return; } onSelect(session); }}><span className="session-copy"><span className="session-title-row"><strong>{session.name}</strong>{activity && !running && <small className="session-activity">{activity}</small>}<span className="session-api-cost" title="Would-be API cost">{formatApiCost(session.apiCost)}</span></span></span></button>
    <button className="session-archive" aria-label="Archive conversation" title={`Archive ${session.name}`} onClick={() => onAction(session, "archive")}><Archive size={14} /></button>
  </div>; };
  const groupsByToken = new Map(groups.map((group) => [groupLayoutToken(group[0]), group] as const));
  const looseSessionsByToken = new Map(ungroupedSessions.map((session) => [sessionLayoutToken(sessionKey(session)), session] as const));
  const renderDropZone = (beforeToken: string | null) => <div key={`drop-${beforeToken ?? "end"}`} data-sidebar-drop-zone data-sidebar-before={beforeToken ?? undefined} data-sidebar-end={beforeToken === null ? true : undefined} className={`sidebar-drop-zone ${dropTarget?.layoutBefore === beforeToken ? "active" : ""}`} />;
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl K</kbd></label>
    <div className="session-scroll">
      {newGroupName !== undefined && <section className="project custom-group-draft"><div className="project-label"><input ref={groupNameRef} aria-label="New session group name" placeholder="Group name" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} /></div></section>}
      {sidebarEntries.flatMap((token) => { const looseSession = looseSessionsByToken.get(token); const group = groupsByToken.get(token); if (looseSession) return [renderDropZone(token), renderSession(looseSession, UNGROUPED_KEY)]; if (!group) return []; const [projectKey, project, hostId, hostName, projectSessions] = group; const label = !hostId || hostId === "local" ? project : `${hostName ?? hostId} / ${project}`; const collapsed = !query && collapsedProjects.has(projectKey); const groupId = `project-${projectKey.replace(/[^a-z0-9_-]/gi, "-")}`; return [renderDropZone(token), <section className={`project ${dropTarget?.projectKey === projectKey && !dropTarget.sessionKey && dropTarget.layoutBefore === undefined ? "drop-project" : ""}`} key={projectKey}>
        <button className="project-label" data-drop-project-key={projectKey} aria-expanded={!collapsed} aria-controls={groupId} onClick={() => toggleProject(projectKey)}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} /><span className={projectKey === activeProjectKey ? "active" : undefined}>{label}</span></button>
        <div id={groupId} hidden={collapsed}>{projectSessions.map((session) => renderSession(session, projectKey))}</div>
      </section>]; })}
      {sidebarEntries.length > 0 && renderDropZone(null)}
      {!filtered.length && <div className="empty-small">No conversations match “{query}”.</div>}
    </div>
    {menu && <div ref={menuRef} className="conversation-menu session-context-menu" role="menu" aria-label={`${menu.session.name} actions`} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    }}>{actions.filter(([action]) => action !== "split" || menu.session.id !== activeId || (menu.session.hostId ?? "local") !== activeHostId).map(([action, Icon, label]) => <button key={action} role="menuitem" onClick={() => { setMenu(undefined); onAction(menu.session, action); }}><Icon size={14} />{label}</button>)}</div>}
  </aside>;
}
