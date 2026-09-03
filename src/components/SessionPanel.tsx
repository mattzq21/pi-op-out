import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, Columns2, CopyPlus, FolderOpen, Pencil, Search } from "lucide-react";
import type { SessionSummary } from "../types";

export type SessionAction = "split" | "rename" | "clone" | "open-directory" | "archive";
interface Props { sessions: SessionSummary[]; activeId?: string; activeHostId?: string; runningSessions?: ReadonlySet<string>; unseenSessions?: ReadonlySet<string>; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onAction: (session: SessionSummary, action: SessionAction) => void; }

const actions = [
  ["split", Columns2, "Split pane"], ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["open-directory", FolderOpen, "Open project directory"]
] as const;
const COLLAPSED_PROJECTS_KEY = "pi-desktop-collapsed-projects";
const sidebarCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function stableSessionOrder(left: SessionSummary, right: SessionSummary) {
  return sidebarCollator.compare(left.name, right.name) || sidebarCollator.compare(left.id, right.id);
}

function savedCollapsedProjects() {
  try { const value = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); }
  catch { return new Set<string>(); }
}

function formatApiCost(cost = 0) {
  if (cost > 0 && cost < .01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function SessionPanel({ sessions, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction }: Props) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number; returnFocus?: HTMLElement }>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(savedCollapsedProjects);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = (restoreFocus = false) => { const target = menu?.returnFocus; setMenu(undefined); if (restoreFocus) requestAnimationFrame(() => target?.focus()); };
  const activeProject = sessions.find((session) => session.id === activeId && (session.hostId ?? "local") === activeHostId)?.project;
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
  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* Persistence is best-effort. */ }
    return next;
  });
  const filtered = sessions.filter((session) => `${session.name} ${session.project} ${session.preview}`.toLowerCase().includes(query.toLowerCase()));
  const groups = Object.entries(filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[`${session.hostId ?? "local"}:${session.project}`] ??= []).push(session); return result;
  }, {})).map(([projectKey, projectSessions]) => [projectKey, projectSessions.sort(stableSessionOrder)] as const).sort(([, left], [, right]) => {
    const leftHost = left[0].hostName ?? left[0].hostId ?? "local";
    const rightHost = right[0].hostName ?? right[0].hostId ?? "local";
    return sidebarCollator.compare(leftHost, rightHost) || sidebarCollator.compare(left[0].project, right[0].project);
  });
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl K</kbd></label>
    <div className="session-scroll">
      {groups.map(([projectKey, projectSessions]) => { const project = projectSessions[0].project; const hostId = projectSessions[0].hostId ?? "local"; const label = hostId === "local" ? project : `${projectSessions[0].hostName ?? hostId} / ${project}`; const collapsed = !query && collapsedProjects.has(projectKey); const groupId = `project-${projectKey.replace(/[^a-z0-9_-]/gi, "-")}`; return <section className="project" key={projectKey}>
        <button className="project-label" aria-expanded={!collapsed} aria-controls={groupId} onClick={() => toggleProject(projectKey)}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} /><span className={project === activeProject && hostId === activeHostId ? "active" : undefined}>{label}</span></button>
        <div id={groupId} hidden={collapsed}>{projectSessions?.map((session) => { const key = `${session.hostId ?? "local"}:${session.id}`; const activity = runningSessions.has(key) ? "Running" : unseenSessions.has(key) ? "New activity" : undefined; return <div key={key} className={`session-item ${activeId === session.id && (session.hostId ?? "local") === activeHostId ? "active" : ""} ${runningSessions.has(key) ? "running" : unseenSessions.has(key) ? "unseen" : ""}`} onContextMenu={(event) => { event.preventDefault(); const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined; setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190), returnFocus }); }}>
          <button className="session-main" aria-label={`${session.name}, ${formatApiCost(session.apiCost)}${activity ? `, ${activity}` : ""}`} onClick={() => onSelect(session)}><span className="session-copy"><span className="session-title-row"><strong>{session.name}</strong>{activity && <small className="session-activity">{activity}</small>}<span className="session-api-cost" title="Would-be API cost">{formatApiCost(session.apiCost)}</span></span></span></button>
          <button className="session-archive" aria-label="Archive conversation" title={`Archive ${session.name}`} onClick={() => onAction(session, "archive")}><Archive size={14} /></button>
        </div>; })}</div>
      </section>; })}
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
