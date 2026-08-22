import { ChevronDown, MoreHorizontal, Search, Star } from "lucide-react";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/content";

interface Props { sessions: SessionSummary[]; activeId?: string; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => void; onProject: () => void; }

export function SessionPanel({ sessions, activeId, query, onQuery, onSelect, onProject }: Props) {
  const filtered = sessions.filter((session) => `${session.name} ${session.project} ${session.preview}`.toLowerCase().includes(query.toLowerCase()));
  const groups = Object.entries(filtered.reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[session.project] ??= []).push(session); return result;
  }, {}));
  return <aside className="session-panel">
    <label className="search"><Search size={15} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => onQuery(event.target.value)} /><kbd>⌘K</kbd></label>
    <div className="session-scroll">
      {groups.map(([project, projectSessions]) => <section className="project" key={project}>
        <div className="project-label"><ChevronDown size={13} /><span>{project}</span><small>{projectSessions?.length}</small></div>
        {projectSessions?.map((session) => <button key={session.id} className={`session-item ${activeId === session.id ? "active" : ""}`} onClick={() => onSelect(session)}>
          <span className="session-copy"><strong>{session.name}</strong><span>{session.preview}</span></span>
          <span className="session-meta">{session.starred && <Star size={11} fill="currentColor" />}{relativeTime(session.updatedAt)}</span>
        </button>)}
      </section>)}
      {!filtered.length && <div className="empty-small">No conversations match “{query}”.</div>}
    </div>
    <button className="project-switcher" onClick={onProject}><span className="project-avatar">{(sessions.find((session) => session.id === activeId)?.project || "PI").slice(0, 2).toUpperCase()}</span><span><strong>{sessions.find((session) => session.id === activeId)?.project || "Open project"}</strong><small>{sessions.find((session) => session.id === activeId)?.cwd || "Choose a working directory"}</small></span><MoreHorizontal size={16} /></button>
  </aside>;
}
