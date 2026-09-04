import { isValidElement, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Check, CircleAlert, Copy, FolderGit2, GitBranch, Wrench } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, GitDiffSnapshot } from "../types";
import { textOf, thinkingOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import { IconButton } from "./IconButton";
import { DiffViewer } from "./DiffViewer";
import { PromptContextBar } from "./PromptContextBar";

interface Props { message: ChatMessage; diff?: GitDiffSnapshot; expanded?: boolean; toolCount?: number; debug?: boolean; onBranch: (message: ChatMessage) => void | Promise<void>; onCreateWorktree?: () => void; onRetry?: () => void; }

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeBlock({ children, node: _node, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(nodeText(children).replace(/\n$/, ""));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  };
  return <div className="code-block"><pre {...props}>{children}</pre>{copyState === "error" && <span className="copy-feedback" role="status">Could not copy</span>}<IconButton label={copyState === "copied" ? "Code copied" : copyState === "error" ? "Copy failed" : "Copy code"} className="code-copy" onClick={copy}>{copyState === "copied" ? <Check size={14} /> : copyState === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton></div>;
}

const markdownComponents: Components = { pre: CodeBlock };

function userMessageParts(content: string) {
  const invocation = content.match(/^<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?<\/skill>(?:\n\n([\s\S]*))?$/);
  if (!invocation) return { skills: [] as string[], text: content, literalSkill: /<\/?skill\b/i.test(content) };
  return { skills: [invocation[1]], text: (invocation[2] ?? "").trim(), literalSkill: false };
}

export function Message({ message, diff, expanded = false, toolCount = 1, debug = false, onBranch, onCreateWorktree, onRetry }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [branching, setBranching] = useState(false);
  const branchingRef = useRef(false);
  if (message.role === "tool") { const output = textOf(message.content); const status = message.toolStatus ?? "done"; return <details className={`tool-event ${status}`} open={status === "running" || (expanded && status !== "done")}><summary><Wrench size={14} /><span><strong>{message.toolName || "tool"}{toolCount > 1 ? ` x${toolCount}` : ""}</strong><small>{status === "running" ? "Running…" : status === "error" ? "Failed" : "Completed"}</small></span><span className="tool-chevron">›</span></summary>{output && <pre>{output}</pre>}</details>; }
  if (message.role === "user") { const { skills, text, literalSkill } = userMessageParts(textOf(message.content)); return <article className="message user-message"><div className="message-body">{skills.map((skill) => <span className="skill-reference" key={skill}>${skill}</span>)}{text && (literalSkill ? <span className="literal-skill-content">{text}</span> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown>)}</div></article>; }
  const output = textOf(message.content);
  const thinking = thinkingOf(message.content);
  const cache = cacheHitStats(message.usage);
  const responseLabel = `Assistant response${message.timestamp ? ` from ${new Date(message.timestamp).toLocaleString()}` : ` ${message.id.slice(0, 8)}`}`;
  const failure = message.stopReason === "aborted" ? (message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(textOf(message.content));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  };
  const branch = async () => {
    if (branchingRef.current) return;
    branchingRef.current = true; setBranching(true);
    try { await onBranch(message); } finally { branchingRef.current = false; setBranching(false); }
  };
  return <article className={`message assistant-message ${thinking ? "reasoning-message" : ""}`} aria-label={responseLabel}>
    <div className="message-body">
      {debug && message.promptContext && <PromptContextBar context={message.promptContext} />}
      {thinking && <div className="reasoning-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{thinking}</ReactMarkdown></div>}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{output}</ReactMarkdown>
      {failure && <div className="message-failure" role="status"><CircleAlert size={14} /><span>{failure}</span>{onRetry && <button onClick={onRetry}>Retry</button>}</div>}
      {message.streaming && <span className="stream-caret" />}
      {diff && <DiffViewer snapshot={diff} />}
      {!message.streaming && output.trim().length > 0 && <div className="message-actions">
        <IconButton label={copyState === "copied" ? `${responseLabel} copied` : copyState === "error" ? `Copy failed for ${responseLabel.toLowerCase()}` : `Copy ${responseLabel.toLowerCase()}`} onClick={copy}>{copyState === "copied" ? <Check size={14} /> : copyState === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>
        {copyState === "error" && <span className="copy-feedback" role="status">Could not copy response</span>}
        <button className="branch-button" aria-label={`Branch from ${responseLabel.toLowerCase()}`} title="Branch from here" disabled={branching} onClick={() => void branch()}><GitBranch size={14} /></button>
        {onCreateWorktree && <button className="branch-button" aria-label="Create Git worktree" title="Create Git worktree" onClick={onCreateWorktree}><FolderGit2 size={14} /></button>}
        {debug && cache && <span className={`cache-hit-rate${cache.low ? " low" : ""}`} title={`${cache.cachedTokens.toLocaleString()} of ${cache.promptTokens.toLocaleString()} prompt tokens read from cache`}>Cache {cache.rate}%</span>}
      </div>}
    </div>
  </article>;
}
