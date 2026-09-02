import { useEffect, useState } from "react";
import { Archive, ChevronDown, Columns2, CopyPlus, FolderOpen, Pencil, Search } from "lucide-react";
import type { SessionSummary } from "../types";

export type SessionAction = "split" | "rename" | "clone" | "open-directory" | "archive";
interface Props { sessions: SessionSummary[]; activeId?: string; activeHostId?: string; runningSessions?: ReadonlySet<string>; unseenSessions?: ReadonlySet<string>; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onAction: (session: SessionSummary, action: SessionAction) => void; }

const actions = [
  ["split", Columns2, "Split pane"], ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["open-directory", FolderOpen, "Open project directory"]
] as const;

function formatApiCost(cost: number) {
  if (cost > 0 && cost < .01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function SessionPanel({ sessions, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction }: Props) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number }>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const activeProject = sessions.find((session) => session.id === activeId && (session.hostId ?? "local") === activeHostId)?.project;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); };
  }, [menu]);
  const filtered = sessions.filter((session) => `${session.name} ${session.project} ${session.preview}`.toLowerCase().includes(query.toLowerCase()));
  const groups = Object.entries(filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[`${session.hostId ?? "local"}:${session.project}`] ??= []).push(session); return result;
  }, {}));
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl K</kbd></label>
    <div className="session-scroll">
      {groups.map(([projectKey, projectSessions]) => { const project = projectSessions[0].project; const hostId = projectSessions[0].hostId ?? "local"; const label = hostId === "local" ? project : `${projectSessions[0].hostName ?? hostId} / ${project}`; const collapsed = !query && collapsedProjects.has(projectKey); const groupId = `project-${projectKey.replace(/[^a-z0-9_-]/gi, "-")}`; return <section className="project" key={projectKey}>
        <button className="project-label" aria-expanded={!collapsed} aria-controls={groupId} onClick={() => setCollapsedProjects((current) => { const next = new Set(current); if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey); return next; })}><ChevronDown className={collapsed ? "collapsed" : ""} size={13} /><span className={project === activeProject && hostId === activeHostId ? "active" : undefined}>{label}</span></button>
        <div id={groupId} hidden={collapsed}>{projectSessions?.map((session) => { const key = `${session.hostId ?? "local"}:${session.id}`; return <div key={key} className={`session-item ${activeId === session.id && (session.hostId ?? "local") === activeHostId ? "active" : ""} ${runningSessions.has(key) ? "running" : unseenSessions.has(key) ? "unseen" : ""}`} onContextMenu={(event) => { event.preventDefault(); setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190) }); }}>
          <button className="session-main" onClick={() => onSelect(session)}><span className="session-copy"><span className="session-title-row"><strong>{session.name}</strong><span className="session-api-cost" title="Would-be API cost">{formatApiCost(session.apiCost)}</span></span></span></button>
          <button className="session-archive" aria-label="Archive conversation" title={`Archive ${session.name}`} onClick={() => onAction(session, "archive")}><Archive size={14} /></button>
        </div>; })}</div>
      </section>; })}
      {!filtered.length && <div className="empty-small">No conversations match “{query}”.</div>}
    </div>
    {menu && <div className="conversation-menu session-context-menu" role="menu" aria-label={`${menu.session.name} actions`} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>{actions.filter(([action]) => action !== "split" || menu.session.id !== activeId || (menu.session.hostId ?? "local") !== activeHostId).map(([action, Icon, label]) => <button key={action} role="menuitem" onClick={() => { setMenu(undefined); onAction(menu.session, action); }}><Icon size={14} />{label}</button>)}</div>}
  </aside>;
}
