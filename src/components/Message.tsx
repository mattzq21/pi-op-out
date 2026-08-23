import { isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Check, CircleAlert, Copy, GitBranch, Wrench } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";
import { textOf, thinkingOf } from "../lib/content";
import { IconButton } from "./IconButton";

interface Props { message: ChatMessage; expanded?: boolean; toolCount?: number; onBranch: (message: ChatMessage) => void; onRetry?: () => void; }

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeBlock({ children, node: _node, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard?.writeText(nodeText(children).replace(/\n$/, "")); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  return <div className="code-block"><pre {...props}>{children}</pre><IconButton label={copied ? "Code copied" : "Copy code"} className="code-copy" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton></div>;
}

const markdownComponents: Components = { pre: CodeBlock };

export function Message({ message, expanded = false, toolCount = 1, onBranch, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  if (message.role === "tool") { const output = textOf(message.content); const status = message.toolStatus ?? "done"; return <details className={`tool-event ${status}`} open={status === "running" || (expanded && status !== "done")}><summary><Wrench size={14} /><span><strong>{message.toolName || "tool"}{toolCount > 1 ? ` x${toolCount}` : ""}</strong><small>{status === "running" ? "Running…" : status === "error" ? "Failed" : "Completed"}</small></span><span className="tool-chevron">›</span></summary>{output && <pre>{output}</pre>}</details>; }
  if (message.role === "user") return <article className="message user-message"><div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{textOf(message.content)}</ReactMarkdown></div></article>;
  const output = textOf(message.content);
  const thinking = thinkingOf(message.content);
  const failure = message.stopReason === "aborted" ? (message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;
  const copy = async () => { await navigator.clipboard?.writeText(textOf(message.content)); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  return <article className="message assistant-message">
    <div className="message-body">
      {thinking && <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{thinking}</ReactMarkdown>}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{output}</ReactMarkdown>
      {failure && <div className="message-failure" role="status"><CircleAlert size={14} /><span>{failure}</span>{onRetry && <button onClick={onRetry}>Retry</button>}</div>}
      {message.streaming && <span className="stream-caret" />}
      {!message.streaming && output.trim().length > 0 && <div className="message-actions">
        <IconButton label="Copy response" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
        <button className="branch-button" aria-label="Branch from here" title="Branch from here" onClick={() => onBranch(message)}><GitBranch size={14} /></button>
      </div>}
    </div>
  </article>;
}
