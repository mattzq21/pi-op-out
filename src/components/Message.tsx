import { useState } from "react";
import { Check, Copy, GitBranch, Sparkles, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";
import { textOf } from "../lib/content";
import { IconButton } from "./IconButton";

interface Props { message: ChatMessage; expanded?: boolean; onBranch: (message: ChatMessage) => void; }

export function Message({ message, expanded = false, onBranch }: Props) {
  const [copied, setCopied] = useState(false);
  if (message.role === "tool") { const output = textOf(message.content); return <details className={`tool-event ${message.toolStatus ?? "done"}`} open={expanded || message.toolStatus === "running"}><summary><Wrench size={14} /><span><strong>{message.toolName || "tool"}</strong><small>{message.toolStatus === "running" ? "Running…" : message.toolStatus === "error" ? "Failed" : "Completed"}</small></span><span className="tool-chevron">›</span></summary>{output && <pre>{output}</pre>}</details>; }
  if (message.role === "user") return <article className="message user-message"><div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{textOf(message.content)}</ReactMarkdown></div></article>;
  const copy = async () => { await navigator.clipboard?.writeText(textOf(message.content)); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  return <article className="message assistant-message">
    <div className="avatar pi-avatar"><Sparkles size={14} /></div>
    <div className="message-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{textOf(message.content)}</ReactMarkdown>
      {message.streaming && <span className="stream-caret" />}
      {!message.streaming && <div className="message-actions">
        <IconButton label="Copy response" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
        <button className="branch-button" aria-label="Branch from here" title="Branch from here" onClick={() => onBranch(message)}><GitBranch size={14} /></button>
      </div>}
    </div>
  </article>;
}
