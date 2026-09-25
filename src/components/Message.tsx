import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, Index } from "solid-js";
import { createDependencyEffect, createRef, cssPixels } from "../lib/solid";

import { Check, ChevronRight, CircleAlert, Copy, FolderGit2, GitBranch, Pause, Undo2, Wrench } from "lucide-solid";
import { textOf, thinkingOf } from "../lib/content";
import { cacheHitStats } from "../lib/messages";
import type { turnDiff } from "../lib/turnDiff";
import { VOICE_MESSAGE } from "../lib/voiceMessages";
import type { ChatMessage } from "../types";
import { DiffViewer } from "./DiffViewer";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import { SubagentResults, subagentRuns } from "./SubagentResults";
import type { FileReference } from "../lib/projectFiles";

interface Props { message: ChatMessage; onOpenFile?: (file: FileReference) => void; turnCacheUsage?: { input: number; cacheRead: number }; diff?: ReturnType<typeof turnDiff>; expanded?: boolean; showActions?: boolean; toolCount?: number; debug?: boolean; paused?: boolean; onBranch?: (message: ChatMessage) => void | Promise<void>; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onRetry?: () => void; retrying?: boolean; }

function cacheTokenDigits(tokens: number) {
  const groups = String(tokens).match(/\d{1,3}(?=(?:\d{3})*$)/g) ?? [];
  return groups.map((group, index) => <span style={{ color: "var(--accent)", opacity: [0.33, 0.66, 1][Math.min(2, groups.length - index - 1)] }}>{group}</span>);
}

function userMessageParts(content: string) {
  const invocation = content.match(/^<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?<\/skill>(?:\n\n([\s\S]*))?$/i);
  if (!invocation) return { skills: [] as string[], text: content, literalSkill: /<\/?skill\b/i.test(content) };
  return { skills: [invocation[1]], text: (invocation[2] ?? "").trim(), literalSkill: false };
}

function formatMessageTime(timestamp?: number) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    short: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    full: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  };
}

function responseFailure(message: ChatMessage, paused: boolean) {
  const pausedResponse = message.stopReason === "aborted" && (paused || message.errorMessage === "Response paused");
  const failure = message.stopReason === "aborted" ? (pausedResponse ? undefined : message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;
  return { pausedResponse, failure };
}

function responseMetadata(message: ChatMessage, turnCacheUsage: Props['turnCacheUsage']) {
  return {
    cache: cacheHitStats(turnCacheUsage ?? message.usage),
    responseLabel: `Assistant response${message.timestamp ? ` from ${new Date(message.timestamp).toLocaleString()}` : ` ${message.id.slice(0, 8)}`}`,
    responseTime: formatMessageTime(message.completedAt ?? message.timestamp),
  };
}

function toolInputLines(message: ChatMessage) {
  const input = message.toolInput === undefined ? undefined : JSON.stringify(message.toolInput, null, 2);
  return input && message.toolInput !== null && typeof message.toolInput === "object" && !Array.isArray(message.toolInput) ? input.slice(1, -1).replace(/^\n|\n$/g, "").replace(/^  /gm, "") : input;
}

function MessageCopyButton(componentProps: { state: "idle" | "copied" | "error"; copy: () => Promise<void> }) {
  return <IconButton title="Copy" label={componentProps.state === "copied" ? "Message copied" : componentProps.state === "error" ? "Copy failed" : "Copy message"} onClick={componentProps.copy}>{componentProps.state === "copied" ? <Check size={14} /> : componentProps.state === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>;
}

function ToolLabel(componentProps: { message: ChatMessage; toolCount: number; status: string }) {
  return <><Wrench size={14} /><span><strong>{componentProps.message.toolName || "tool"}{componentProps.toolCount > 1 ? ` x${componentProps.toolCount}` : ""}</strong><small>{componentProps.status === "running" ? "Running…" : componentProps.status === "error" ? "Failed" : "Completed"}</small></span></>;
}

function ToolPayload(componentProps: { message: ChatMessage; loading: boolean; error?: string; retry: () => void }) {
  const input = createMemo(() => (toolInputLines(componentProps.message)));
  const output = createMemo(() => (textOf(componentProps.message.content)));
  const runs = createMemo(() => componentProps.message.toolName === "subagent" ? subagentRuns(componentProps.message.details) : []);
  return <>
    {runs().length > 0 ? <SubagentResults runs={runs()} /> : <>
      {input() !== undefined && <div class="tool-payload"><div class="tool-payload-label">In</div><div class="tool-input" aria-label="Tool arguments"><pre>{(input())!}</pre></div></div>}
      {output() && <div class="tool-payload"><div class="tool-payload-label">Out</div><div class="tool-output" aria-label="Tool output"><pre>{output()}</pre></div></div>}
    </>}
    {componentProps.loading && <div role="status">Loading tool input and output…</div>}
    {componentProps.error && <div role="alert">{(componentProps.error)!} <button onClick={componentProps.retry}>Retry</button></div>}
    {Array.isArray(componentProps.message.content) && <Index each={componentProps.message.content.filter((part) => part.type === "image")}>{(part) => part().type === "image" && part().data && /^image\/(png|jpeg|gif|webp)$/.test(part().mimeType ?? "") ? <img src={`data:${part().mimeType};base64,${part().data}`} alt="Tool result" style={{ "max-width": "100%", "max-height": "320px", "object-fit": "contain" }} /> : null}</Index>}
    {!componentProps.loading && !componentProps.error && componentProps.message.deferredToolPayload && !componentProps.message.toolPayloadLoaded && <button onClick={componentProps.retry}>Load input and output</button>}
  </>;
}

function ToolResult(componentProps: Pick<Props, "message" | "toolCount" | "debug">) {
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal(0);
  createDependencyEffect(() => {
    if (!open()) return;
    let active = true; let pending = false;
    let failed: { version?: number } | undefined;
    const refresh = () => {
      const message = componentProps.message;
      if (pending || !message.loadToolPayload || failed && failed.version === message.toolPayloadVersion || message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion) return;
      pending = true;
      setLoading(true); setError(undefined);
      void message.loadToolPayload().catch((reason) => { if (active) { failed = { version: message.toolPayloadVersion }; setError(reason instanceof Error ? reason.message : String(reason)); } })
        .finally(() => { pending = false; if (active) setLoading(false); });
    };
    refresh(); const timer = setInterval(refresh, 300);
    return () => { active = false; clearInterval(timer); };
  }, () => [open(), retry()]);
  const status = createMemo(() => (componentProps.message.toolStatus ?? "done"));
  const label = createMemo(() => (<ToolLabel message={componentProps.message} toolCount={componentProps.toolCount ?? 1} status={status()} />));

  return <>{!componentProps.debug && componentProps.message.toolName !== "subagent" ? (<div class={`tool-event ${status()}`}><div class="tool-summary">{label()}</div></div>) : (<details class={`tool-event ${status()}`} open={open()} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="tool-summary">{label()}<ChevronRight size={12} class="tool-chevron" aria-hidden="true" /></summary>
    {open() && <ToolPayload message={componentProps.message} loading={loading()} error={error()} retry={() => setRetry((value) => value + 1)} />}
  </details>)}</>;
}

export function Message(componentProps: Props) {
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "error">("idle");
  const [branching, setBranching] = createSignal(false);
  const branchingRef = createRef(false);
  const [forgetting, setForgetting] = createSignal(false);
  const forgettingRef = createRef(false);

  const copy = async () => { const capturedMessage0 = componentProps.message;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(textOf(capturedMessage0.content));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  };

  const UserMessage = () => {
    const parts = createMemo(() => userMessageParts(textOf(componentProps.message.content)));
    const sentTime = createMemo(() => formatMessageTime(componentProps.message.timestamp));
    return <article class={`message user-message${componentProps.message.deliveryBehavior === "steer" ? " steering-message" : ""}`} title={sentTime() ? `Sent ${sentTime()!.full}` : undefined}>
      <div class="message-body">{<Key each={parts().skills} by={(skill) => skill}>{(skill, index) => <span class="skill-reference" >${skill()}</span>}</Key>}{parts().text && (parts().literalSkill ? <span class="literal-skill-content">{parts().text}</span> : <Markdown>{parts().text}</Markdown>)}</div>
      {Array.isArray(componentProps.message.content) && <Index each={componentProps.message.content.flatMap(part => part.type === "image" ? [part] : [])}>{(part, index) => part().type === "image" && part().data && part().mimeType && /^image\/(png|jpeg|gif|webp)$/.test(part().mimeType) ? <img  src={`data:${part().mimeType};base64,${part().data}`} alt="Sent attachment" style={{ "max-width": "100%", "max-height": cssPixels(320), "object-fit": "contain" }} /> : null}</Index>}
      <div class="message-actions">
        {sentTime() && <span class="message-time" title={sentTime()!.full}>{sentTime()!.short}</span>}
        <MessageCopyButton state={copyState()} copy={copy} />
        {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy message</span>}
      </div>
    </article>;
  };

  const output = createMemo(() => (textOf(componentProps.message.content)));
  const thinking = createMemo(() => (thinkingOf(componentProps.message.content)));
  const metadata = createMemo(() => (responseMetadata(componentProps.message, componentProps.turnCacheUsage)));
  const voiceResponse = createMemo(() => (componentProps.message.customType === VOICE_MESSAGE));
  const failureState = createMemo(() => (responseFailure(componentProps.message, (componentProps.paused === undefined ? false : componentProps.paused))));
  const branch = async () => { const capturedOnBranch0 = componentProps.onBranch; const capturedMessage1 = componentProps.message;
    if (!capturedOnBranch0 || branchingRef.current || forgettingRef.current) return;
    branchingRef.current = true; setBranching(true);
    try { await (capturedOnBranch0)!(capturedMessage1); } finally { branchingRef.current = false; setBranching(false); }
  };
  const forkAndForget = async () => { const capturedOnForkAndForget0 = componentProps.onForkAndForget; const capturedMessage1 = componentProps.message;
    if (!capturedOnForkAndForget0 || branchingRef.current || forgettingRef.current) return;
    forgettingRef.current = true; setForgetting(true);
    try { await (capturedOnForkAndForget0)!(capturedMessage1); } finally { forgettingRef.current = false; setForgetting(false); }
  };
  const renderMessageBody = () => {
    const renderVoiceResponseBubble = () => (voiceResponse() ? <div class="voice-response-bubble"><Markdown streaming={componentProps.message.streaming}>{output()}</Markdown>{componentProps.message.streaming && <span class="stream-caret" />}</div> : <Markdown onOpenFile={componentProps.onOpenFile} streaming={componentProps.message.streaming}>{output()}</Markdown>);
    const renderMessageFailure = () => (failureState().failure && <div class="message-failure" role="status"><CircleAlert size={14} /><span>{(failureState().failure)!}</span>{componentProps.onRetry && <button disabled={(componentProps.retrying === undefined ? false : componentProps.retrying)} onClick={(componentProps.onRetry)!}>{(componentProps.retrying === undefined ? false : componentProps.retrying) ? "Retrying…" : "Retry"}</button>}</div>);
    const renderStreamCaret = () => (componentProps.message.streaming && !voiceResponse() && <span class="stream-caret" />);
    const renderMessageActions = () => {
      const renderCopyResponse = () => (<IconButton title="Copy" label={copyState() === "copied" ? `${metadata().responseLabel} copied` : copyState() === "error" ? `Copy failed for ${metadata().responseLabel.toLowerCase()}` : `Copy ${metadata().responseLabel.toLowerCase()}`} onClick={copy}>{copyState() === "copied" ? <Check size={14} /> : copyState() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>);
      const renderBranchAction = () => (componentProps.onBranch && <button class="branch-button" aria-label={`Branch from ${metadata().responseLabel.toLowerCase()}`} title="Branch from here" disabled={branching() || forgetting()} onClick={() => void branch()}><GitBranch size={14} /></button>);
      const renderForkAndForgetAction = () => (componentProps.onForkAndForget && <button class="branch-button" aria-label={`Fork and forget from ${metadata().responseLabel.toLowerCase()}`} title="Fork and forget from here" disabled={branching() || forgetting()} onClick={() => void forkAndForget()}><Undo2 size={14} /></button>);
      const renderCacheHitRate = () => ((componentProps.debug === undefined ? false : componentProps.debug) && metadata().cache && <span class={`cache-hit-rate${(metadata().cache)!.low ? " low" : ""}`} tabIndex={0} aria-label={`Cache ${(metadata().cache)!.rate}%, ${(metadata().cache)!.cachedTokens}/${(metadata().cache)!.promptTokens}`}>Cache {(metadata().cache)!.rate}%<span class="cache-fraction-tooltip" aria-hidden="true"><span>{cacheTokenDigits((metadata().cache)!.cachedTokens)}</span><span>{cacheTokenDigits((metadata().cache)!.promptTokens)}</span></span></span>);
      return ((componentProps.showActions === undefined ? true : componentProps.showActions) && !componentProps.message.streaming && (output().trim().length > 0 || componentProps.onCreateWorktree) && <div class="message-actions">
        {renderCopyResponse()}
        {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy response</span>}
        {renderBranchAction()}
        {renderForkAndForgetAction()}
        {componentProps.onCreateWorktree && <button class="branch-button" aria-label="Create Git worktree" title="Create Git worktree after this response" onClick={() => (componentProps.onCreateWorktree)!(componentProps.message)}><FolderGit2 size={14} /></button>}
        {renderCacheHitRate()}
        {metadata().responseTime && <span class="message-time">{(metadata().responseTime)!.short}</span>}
      </div>);
    };
    return (<div class="message-body">
      {thinking() && <div class="reasoning-text"><Markdown streaming={componentProps.message.streaming}>{thinking()}</Markdown></div>}
      {renderVoiceResponseBubble()}
      {renderMessageFailure()}
      {failureState().pausedResponse && <div class="message-paused" role="status"><Pause size={14} /><span>Response paused</span></div>}
      {renderStreamCaret()}
      {componentProps.diff && <DiffViewer {...(componentProps.diff)!} />}
      {renderMessageActions()}
    </div>);
  };
  const renderAssistantMessage = () => (<article class={`message assistant-message ${thinking() ? "reasoning-message" : ""}`} aria-label={metadata().responseLabel}>
    {renderMessageBody()}
  </article>);
  return <>{componentProps.message.role === "system" ? (<div class="command-result" role="status">{textOf(componentProps.message.content)}</div>) : componentProps.message.role === "tool" ? (<ToolResult message={componentProps.message} toolCount={(componentProps.toolCount === undefined ? 1 : componentProps.toolCount)} debug={(componentProps.debug === undefined ? false : componentProps.debug)} />) : componentProps.message.role === "user" ? (<UserMessage />) : (renderAssistantMessage())}</>;
}
