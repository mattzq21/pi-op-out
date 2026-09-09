import { isValidElement, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CircleAlert, Copy, FolderGit2, GitBranch, Pause, Wrench } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, GitDiffSnapshot } from "../types";
import { textOf, thinkingOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import { openExternalUrl } from "../lib/nativeTransport";
import { IconButton } from "./IconButton";
import { DiffViewer } from "./DiffViewer";

interface Props { message: ChatMessage; turnCacheUsage?: { input: number; cacheRead: number }; diff?: GitDiffSnapshot; expanded?: boolean; showActions?: boolean; toolCount?: number; debug?: boolean; paused?: boolean; onBranch?: (message: ChatMessage) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onRetry?: () => void; retrying?: boolean; }

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

function MarkdownLink({ children, href }: ComponentPropsWithoutRef<"a">) {
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; returnFocus?: HTMLElement }>();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const close = () => setMenu(undefined);
    const outside = (event: Event) => { if (!element.contains(event.target as Node)) close(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        menu.returnFocus?.focus({ preventScroll: true }); close();
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.preventDefault();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  let url: string | undefined;
  try {
    const parsed = new URL(href ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href;
  } catch { /* Relative and non-web destinations remain readable text. */ }
  if (!url) return <span className="message-link" title={href}>{children}</span>;
  const copyLink = async () => {
    setError(undefined);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(url);
    } catch { setError("Could not copy link"); }
    menu?.returnFocus?.focus({ preventScroll: true }); setMenu(undefined);
  };
  return <><a ref={linkRef} className="message-link" href={url} title={`Click to open in browser\n${url}`} onContextMenu={(event) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX || bounds.left, y: event.clientY || bounds.bottom, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget });
  }} onAuxClick={(event) => event.preventDefault()} onClick={(event) => {
    event.preventDefault();
    if (event.button !== 0) return;
    setError(undefined);
    void openExternalUrl(url).catch((reason) => setError(`Could not open link: ${reason instanceof Error ? reason.message : String(reason)}`));
  }}>{children}</a>{menu && createPortal(<div ref={menuRef} className="conversation-menu link-context-menu" role="menu" aria-label="Link actions" style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
    <button type="button" role="menuitem" onClick={() => void copyLink()}><Copy size={14} />Copy link</button>
  </div>, linkRef.current?.closest(".app") ?? document.body)}{error && <span className="message-link-error" role="alert"> {error}</span>}</>;
}

const markdownComponents: Components = {
  pre: CodeBlock,
  // Open web links only through an explicit gesture and the native browser
  // launcher. Remote Markdown images never load in the application webview.
  a: MarkdownLink,
  img: ({ alt }) => <span className="message-image-placeholder" role="img" aria-label={alt || "Blocked remote image"}>[Image: {alt || "blocked"}]</span>,
};

function userMessageParts(content: string) {
  const invocation = content.match(/^<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?<\/skill>(?:\n\n([\s\S]*))?$/);
  if (!invocation) return { skills: [] as string[], text: content, literalSkill: /<\/?skill\b/i.test(content) };
  return { skills: [invocation[1]], text: (invocation[2] ?? "").trim(), literalSkill: false };
}

export function Message({ message, turnCacheUsage, diff, expanded = false, showActions = true, toolCount = 1, debug = false, paused = false, onBranch, onCreateWorktree, onRetry, retrying = false }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [branching, setBranching] = useState(false);
  const branchingRef = useRef(false);

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
  if (message.role === "system") return <div className="command-result" role="status">{textOf(message.content)}</div>;
  if (message.role === "tool") {
    const output = textOf(message.content);
    const status = message.toolStatus ?? "done";
    const label = <><Wrench size={14} /><span><strong>{message.toolName || "tool"}{toolCount > 1 ? ` x${toolCount}` : ""}</strong><small>{status === "running" ? "Running…" : status === "error" ? "Failed" : "Completed"}</small></span></>;
    if (!debug) return <div className={`tool-event ${status}`}><div className="tool-summary">{label}</div></div>;
    const input = message.toolInput === undefined ? undefined : JSON.stringify(message.toolInput, null, 2);
    const inputLines = input && message.toolInput !== null && typeof message.toolInput === "object" ? input.slice(1, -1).replace(/^\n|\n$/g, "").replace(/^  /gm, "") : input;
    return <details className={`tool-event ${status}`} open={status === "running" || (expanded && status !== "done")}><summary className="tool-summary">{label}<ChevronRight size={12} className="tool-chevron" aria-hidden="true" /></summary>{inputLines !== undefined && <div className="tool-input" aria-label="Tool arguments"><pre>{inputLines}</pre></div>}{output && <div className="tool-output"><strong>Output</strong><pre>{output}</pre></div>}</details>;
  }
  if (message.role === "user") {
    const { skills, text, literalSkill } = userMessageParts(textOf(message.content));
    return <article className={`message user-message${message.deliveryBehavior === "steer" ? " steering-message" : ""}`}>
      <div className="message-body">{skills.map((skill) => <span className="skill-reference" key={skill}>${skill}</span>)}{text && (literalSkill ? <span className="literal-skill-content">{text}</span> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown>)}</div>
      {Array.isArray(message.content) && message.content.map((part, index) => part.type === "image" && part.data && part.mimeType && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) ? <img key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Sent attachment" style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain" }} /> : null)}
      <div className="message-actions">
        <IconButton label={copyState === "copied" ? "Message copied" : copyState === "error" ? "Copy failed" : "Copy message"} onClick={copy}>{copyState === "copied" ? <Check size={14} /> : copyState === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>
        {copyState === "error" && <span className="copy-feedback" role="status">Could not copy message</span>}
        {onCreateWorktree && <button className="branch-button" aria-label="Branch before this prompt" title="Branch before this prompt (latest 10 checkpoints)" onClick={() => onCreateWorktree(message)}><FolderGit2 size={14} /></button>}
      </div>
    </article>;
  }
  const output = textOf(message.content);
  const thinking = thinkingOf(message.content);
  const cache = cacheHitStats(turnCacheUsage ?? message.usage);
  const responseLabel = `Assistant response${message.timestamp ? ` from ${new Date(message.timestamp).toLocaleString()}` : ` ${message.id.slice(0, 8)}`}`;
  const pausedResponse = message.stopReason === "aborted" && (paused || message.errorMessage === "Response paused");
  const failure = message.stopReason === "aborted" ? (pausedResponse ? undefined : message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;
  const branch = async () => {
    if (!onBranch || branchingRef.current) return;
    branchingRef.current = true; setBranching(true);
    try { await onBranch(message); } finally { branchingRef.current = false; setBranching(false); }
  };
  return <article className={`message assistant-message ${thinking ? "reasoning-message" : ""}`} aria-label={responseLabel}>
    <div className="message-body">
      {thinking && <div className="reasoning-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{thinking}</ReactMarkdown></div>}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{output}</ReactMarkdown>
      {failure && <div className="message-failure" role="status"><CircleAlert size={14} /><span>{failure}</span>{onRetry && <button disabled={retrying} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button>}</div>}
      {pausedResponse && <div className="message-paused" role="status"><Pause size={14} /><span>Response paused</span></div>}
      {message.streaming && <span className="stream-caret" />}
      {diff && <DiffViewer snapshot={diff} />}
      {showActions && !message.streaming && output.trim().length > 0 && <div className="message-actions">
        <IconButton label={copyState === "copied" ? `${responseLabel} copied` : copyState === "error" ? `Copy failed for ${responseLabel.toLowerCase()}` : `Copy ${responseLabel.toLowerCase()}`} onClick={copy}>{copyState === "copied" ? <Check size={14} /> : copyState === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>
        {copyState === "error" && <span className="copy-feedback" role="status">Could not copy response</span>}
        {onBranch && <button className="branch-button" aria-label={`Branch from ${responseLabel.toLowerCase()}`} title="Branch from here" disabled={branching} onClick={() => void branch()}><GitBranch size={14} /></button>}
        {onCreateWorktree && <button className="branch-button" aria-label="Create Git worktree" title="Create Git worktree" onClick={() => onCreateWorktree(message)}><FolderGit2 size={14} /></button>}
        {debug && cache && <span className={`cache-hit-rate${cache.low ? " low" : ""}`} title={`${cache.cachedTokens.toLocaleString()} of ${cache.promptTokens.toLocaleString()} prompt tokens read from cache${turnCacheUsage ? " across all calls in this response" : ""}`}>Cache {cache.rate}%</span>}
      </div>}
    </div>
  </article>;
}
