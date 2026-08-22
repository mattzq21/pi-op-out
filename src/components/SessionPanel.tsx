import { useEffect, useState } from "react";
import { Archive, ChevronDown, CopyPlus, FileDown, GitFork, Pencil, Search, Star } from "lucide-react";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/content";

export type SessionAction = "rename" | "clone" | "compact" | "export" | "inspect";
interface Props { sessions: SessionSummary[]; activeId?: string; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onAction: (session: SessionSummary, action: SessionAction) => void; }

const actions = [
  ["rename", Pencil, "Rename conversation"], ["clone", CopyPlus, "Clone conversation"], ["compact", Archive, "Compact context"], ["export", FileDown, "Export as HTML"], ["inspect", GitFork, "Tree & session stats"]
] as const;

export function SessionPanel({ sessions, activeId, query, onQuery, onSelect, onAction }: Props) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number }>();
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
    (result[session.project] ??= []).push(session); return result;
  }, {}));
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>Ctrl K</kbd></label>
    <div className="session-scroll">
      {groups.map(([project, projectSessions]) => <section className="project" key={project}>
        <div className="project-label"><ChevronDown size={13} /><span>{project}</span><small>{projectSessions?.length}</small></div>
        {projectSessions?.map((session) => <button key={session.id} className={`session-item ${activeId === session.id ? "active" : ""}`} onClick={() => onSelect(session)} onContextMenu={(event) => { event.preventDefault(); setMenu({ session, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 190) }); }}>
          <span className="session-copy"><strong>{session.name}</strong><span>{session.preview}</span></span>
          <span className="session-meta">{session.starred && <Star size={11} fill="currentColor" />}{relativeTime(session.updatedAt)}</span>
        </button>)}
      </section>)}
      {!filtered.length && <div className="empty-small">No conversations match “{query}”.</div>}
    </div>
    {menu && <div className="conversation-menu session-context-menu" role="menu" aria-label={`${menu.session.name} actions`} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>{actions.map(([action, Icon, label]) => <button key={action} role="menuitem" onClick={() => { setMenu(undefined); onAction(menu.session, action); }}><Icon size={14} />{label}</button>)}</div>}
  </aside>;
}
