import { GitBranch, MessageSquare, Wrench, X } from "lucide-react";
import { IconButton } from "./IconButton";

export interface SessionStats { sessionId: string; sessionFile?: string; userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }; }
export interface TreeNode { entry: { id: string; type: string; message?: { role?: string; content?: unknown } }; children: TreeNode[]; label?: string; }

export function SessionInspector({ stats, tree, leafId, onClose }: { stats: SessionStats; tree: TreeNode[]; leafId: string | null; onClose: () => void }) {
  const contextPercent = stats.contextUsage?.percent;
  return <div className="inspector-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="session-inspector"><header><div><p className="eyebrow">Session</p><h2>Context & branches</h2></div><IconButton label="Close inspector" onClick={onClose}><X size={18} /></IconButton></header>
    <div className="stat-grid"><Stat icon={<MessageSquare />} value={stats.totalMessages} label="messages" /><Stat icon={<Wrench />} value={stats.toolCalls} label="tool calls" /><Stat icon={<GitBranch />} value={countBranches(tree)} label="branches" /></div>
    <section className="context-card"><div><strong>Context window</strong><span>{stats.contextUsage?.tokens?.toLocaleString() ?? "—"} / {stats.contextUsage?.contextWindow?.toLocaleString() ?? "—"}</span></div><div className="context-track"><span style={{ width: `${Math.min(contextPercent ?? 0, 100)}%` }} /></div><small>{contextPercent == null ? "Available after the next response" : `${contextPercent.toFixed(1)}% used`} · ${stats.tokens.total.toLocaleString()} billed tokens · ${formatCost(stats.cost)}</small></section>
    <section className="tree-section"><h3>Conversation tree</h3><div className="tree-list">{tree.length ? tree.map((node) => <TreeItem key={node.entry.id} node={node} leafId={leafId} depth={0} />) : <p>No entries yet.</p>}</div></section>
    {stats.sessionFile && <footer><span>Session file</span><code>{stats.sessionFile}</code></footer>}
  </aside></div>;
}
function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) { return <div className="stat"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>; }
function TreeItem({ node, leafId, depth }: { node: TreeNode; leafId: string | null; depth: number }) { const message = node.entry.message; return <><div className={`tree-item ${node.entry.id === leafId ? "leaf" : ""}`} style={{ paddingLeft: 8 + depth * 15 }}><span className="tree-dot" /><span>{node.label || message?.role || node.entry.type}</span><code>{node.entry.id.slice(0, 7)}</code></div>{node.children.map((child) => <TreeItem key={child.entry.id} node={child} leafId={leafId} depth={depth + 1} />)}</>; }
function countBranches(nodes: TreeNode[]): number { let branches = 0; const visit = (node: TreeNode) => { if (node.children.length > 1) branches += node.children.length - 1; node.children.forEach(visit); }; nodes.forEach(visit); return branches; }
function formatCost(cost: number) { return cost < .01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`; }
