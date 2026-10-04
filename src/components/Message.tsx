import { z, type JSONType } from "zod";
import { required } from "../lib/required";
import { ReviewLink } from "./ReviewLink";
import { HtmlPreview } from "./HtmlPreview";
import { AgentDelivery } from "./AgentDelivery";
import { Key } from "@solid-primitives/keyed";
import { type Accessor, createMemo, createSignal, Index } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import { Check, ChevronRight, CircleAlert, Copy, FolderGit2, Pause, Split, Undo2, Wrench } from "lucide-solid";
import { textOf, thinkingOf } from "../lib/content";
import { cacheHitStats, isContextInjection } from "../lib/messages";
import { ToolFailureMeter } from "./ToolFailureMeter";
import type { ToolFailureStats } from "../lib/toolFailureStats";
import type { turnDiff } from "../lib/turnDiff";
import type { ChatMessage } from "../types";
import { DiffViewer } from "./DiffViewer";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import { ZoomableImage } from "./ZoomableImage";
import { SubagentResults, subagentRuns } from "./SubagentResults";
import type { FileReference } from "../lib/projectFiles";

interface Props { toolFailures?: ToolFailureStats; message: ChatMessage; onOpenFile?: (file: FileReference) => void; turnCacheUsage?: { input: number; cacheRead: number }; diff?: ReturnType<typeof turnDiff>; expanded?: boolean; showActions?: boolean; toolCount?: number; debug?: boolean; paused?: boolean; onBranch?: (message: ChatMessage) => void | Promise<void>; canRollback?: boolean; onForkAndForget?: (message: ChatMessage, restoreWorktree?: boolean) => void | Promise<void>; onCreateWorktree?: (message: ChatMessage) => void; onRetry?: () => void; retrying?: boolean; }

function cacheTokenDigits(tokens: number) {
  const groups = String(tokens).match(/\d{1,3}(?=(?:\d{3})*$)/g) ?? [];

  return groups.map((group, index) => <span style={{ color: "var(--accent)", opacity: [0.33, 0.66, 1][Math.min(2, groups.length - index - 1)] }}>{group}</span>);
}

function userMessageParts(content: string) {
  const invocation = content.match(/^<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?<\/skill>(?:\n\n([\s\S]*))?$/i);

  if (!invocation) return { skills: [] satisfies string[], text: content, literalSkill: /<\/?skill\b/i.test(content) };

  return { skills: [invocation[1]], text: (invocation[2] ?? "").trim(), literalSkill: false };
}

const shortMessageTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const fullMessageTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatMessageTime(timestamp?: number) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return undefined;

  return {
    short: Date.now() - timestamp < 24 * 60 * 60 * 1000
      ? shortMessageTime.format(date)
      : fullMessageTime.format(date),
    full: fullMessageTime.format(date),
  };
}

function responseFailure(message: ChatMessage, paused: boolean) {
  const pauseMarker = message.errorMessage === "Response paused";
  const pausedResponse = message.stopReason === "aborted" && paused;
  const failure = message.stopReason === "aborted" ? (pausedResponse || pauseMarker ? undefined : message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;

  return { pausedResponse, failure };
}

function responseMetadata(message: Accessor<ChatMessage>, turnCacheUsage: Accessor<Props['turnCacheUsage']>) {
  const timestamp = createMemo(() => message().timestamp);
  const completedAt = createMemo(() => message().completedAt ?? timestamp());
  const id = createMemo(() => message().id);
  const responseLabel = createMemo(() => `Assistant response${timestamp() ? ` from ${new Date(required(timestamp())).toLocaleString()}` : ` ${id().slice(0, 8)}`}`);
  const responseTime = createMemo(() => formatMessageTime(completedAt()));

  return createMemo(() => ({ cache: cacheHitStats(turnCacheUsage() ?? message().usage), responseLabel: responseLabel(), responseTime: responseTime() }));
}

function toolInputLines(value: JSONType | undefined) {
  const input = value === undefined ? undefined : JSON.stringify(value, null, 2);

  return input && z.record(z.string(), z.json()).safeParse(value).success ? input.slice(1, -1).replace(/^\n|\n$/g, "").replace(/^  /gm, "") : input;
}

function MessageCopyButton(componentProps: { state: "idle" | "copied" | "error"; copy: () => Promise<void> }) {
  return <IconButton title="Copy" label={componentProps.state === "copied" ? "Message copied" : componentProps.state === "error" ? "Copy failed" : "Copy message"} onClick={componentProps.copy}>{componentProps.state === "copied" ? <Check size={14} /> : componentProps.state === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>;
}

function ToolLabel(componentProps: { message: ChatMessage; toolCount: number; status: string }) {
  return <>{componentProps.message.toolName !== "codemode" && <Wrench size={14} />}<span><strong>{componentProps.message.toolName || "tool"}{componentProps.toolCount > 1 ? ` x${componentProps.toolCount}` : ""}</strong><small>{componentProps.status === "running" ? "Running…" : componentProps.status === "error" ? "Failed" : componentProps.status === "unfinished" ? "Unfinished" : "Completed"}</small></span></>;
}

function ToolPayload(componentProps: { message: ChatMessage; loading: boolean; error?: string; retry: () => void }) {
  const toolInput = createMemo(() => componentProps.message.toolInput);
  const input = createMemo(() => toolInputLines(z.json().optional().catch(undefined).parse(toolInput())));
  const output = createMemo(() => (textOf(componentProps.message.content)));
  const needsLoad = () => !componentProps.loading && !componentProps.error && componentProps.message.deferredToolPayload && !componentProps.message.toolPayloadLoaded;

  return <>
      {input() !== undefined && <div class="tool-payload"><div class="tool-payload-label">In</div><div class="tool-input" aria-label="Tool arguments"><pre>{(input())}</pre></div></div>}
      {Boolean(componentProps.message.nestedCalls?.calls.length) && <div class="tool-payload nested-tool-calls" role="group" aria-label="Nested tool calls"><Key each={componentProps.message.nestedCalls?.calls ?? []} by={call => call.id}>{call => <ToolResult debug
        status={call().status === "ok" ? "done" : call().status === "error" ? "error" : componentProps.message.toolStatus === "running" && !componentProps.message.nestedCalls?.complete ? "running" : "unfinished"}
        message={{ id: call().id, role: "tool", toolName: call().name, toolInput: call().arguments, content: call().error ?? "" }}
      />}</Key></div>}
      {output() && <div class="tool-payload"><div class="tool-payload-label">Out</div><div class="tool-output" aria-label="Tool output"><pre>{output()}</pre></div></div>}
    {componentProps.loading && <div role="status">Loading tool input and output…</div>}
    {componentProps.error && <div role="alert">{(componentProps.error)} <button onClick={componentProps.retry}>Retry</button></div>}
    {Array.isArray(componentProps.message.content) && <Index each={componentProps.message.content.filter((part) => part.type === "image")}>{(part) => part().type === "image" && part().data && /^image\/(png|jpeg|gif|webp)$/.test(part().mimeType ?? "") ? <ZoomableImage src={`data:${part().mimeType};base64,${part().data}`} alt="Tool result" /> : null}</Index>}
    {needsLoad() && <button onClick={componentProps.retry}>Load input and output</button>}
  </>;
}

function ToolResult(componentProps: Pick<Props, "message" | "toolCount" | "debug"> & { status?: "running" | "done" | "error" | "unfinished" }) {
  const isSubagent = () => componentProps.message.toolName === "subagent";
  const runs = createMemo(() => componentProps.message.toolName === "subagent" ? subagentRuns(componentProps.message.details) : []);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal(0);
  createDependencyEffect(() => {
    if (!open() && !isSubagent()) return;
    let active = true; let pending = false;
    let failed: { version?: number } | undefined;

    const refresh = () => {
      const message = componentProps.message;

      if (pending || !message.loadToolPayload || failed && failed.version === message.toolPayloadVersion || message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion) return;
      pending = true;
      setLoading(true); setError(undefined);
      void message.loadToolPayload().catch((reason) => { if (active) { failed = { version: message.toolPayloadVersion }; setError(reason instanceof Error ? reason.message : String(reason)); } })
        .finally(() => { pending = false;

        if (active) setLoading(false); });
    };

    refresh(); const timer = setInterval(refresh, 300);

    return () => { active = false; clearInterval(timer); };
  }, () => [open(), retry(), isSubagent()]);
  const status = createMemo(() => (componentProps.status ?? componentProps.message.toolStatus ?? "done"));
  const label = createMemo(() => (<ToolLabel message={componentProps.message} toolCount={componentProps.toolCount ?? 1} status={status()} />));

  return <>{!componentProps.debug && !isSubagent() ? (<div class={`tool-event ${status()}`}><div class="tool-summary">{label()}</div></div>) : (<details class={`tool-event ${status()}`} open={open()} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="tool-summary">{label()}<ChevronRight size={12} class="tool-chevron" aria-hidden="true" /></summary>
    {open() && <ToolPayload message={componentProps.message} loading={loading()} error={error()} retry={() => setRetry((value) => value + 1)} />}
  </details>)}
    {runs().length > 0 && <SubagentResults runs={runs()} />}
    {isSubagent() && !open() && error() && <div role="alert">{error()} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
  </>;
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
    const images = createMemo(() => Array.isArray(componentProps.message.content) ? componentProps.message.content.flatMap(part => part.type === "image" && part.data && part.mimeType && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) ? [part] : []) : []);

    return <article class={`message user-message${componentProps.message.deliveryBehavior === "steer" ? " steering-message" : ""}`}>
      {images().length > 0 && <div class="user-message-images"><Index each={images()}>{part => <ZoomableImage src={`data:${part().mimeType};base64,${part().data}`} alt="Sent attachment" />}</Index></div>}
      {(parts().text || parts().skills.length > 0) && <div class="message-body">
      {<Key each={parts().skills} by={(skill) => skill}>{(skill, _index) => <span class="skill-reference" >${skill()}</span>}</Key>}{parts().text && (parts().literalSkill ? <span class="literal-skill-content">{parts().text}</span> : <Markdown>{parts().text}</Markdown>)}
      </div>}
      <div class="message-actions">
        {sentTime() && <span class="message-time">{required(sentTime()).short}</span>}
        <MessageCopyButton state={copyState()} copy={copy} />
        {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy message</span>}
      </div>
    </article>;
  };

  const renderAssistantMessage = () => {
    const output = createMemo(() => (textOf(componentProps.message.content)));
    const thinking = createMemo(() => (thinkingOf(componentProps.message.content)));
    const streaming = createMemo(() => componentProps.message.streaming);
    const metadata = responseMetadata(() => componentProps.message, () => componentProps.turnCacheUsage);
    const failureState = createMemo(() => (responseFailure(componentProps.message, (componentProps.paused === undefined ? false : componentProps.paused))));

    const branch = async () => { const capturedOnBranch0 = componentProps.onBranch; const capturedMessage1 = componentProps.message;

      if (!capturedOnBranch0 || branchingRef.current || forgettingRef.current) return;
      branchingRef.current = true; setBranching(true);

      try { await (capturedOnBranch0)(capturedMessage1); } finally { branchingRef.current = false; setBranching(false); }
    };

    const forkAndForget = async (restoreWorktree = false) => { const capturedOnForkAndForget0 = componentProps.onForkAndForget; const capturedMessage1 = componentProps.message;

      if (!capturedOnForkAndForget0 || branchingRef.current || forgettingRef.current) return;
      forgettingRef.current = true; setForgetting(true);

      try { await (capturedOnForkAndForget0)(capturedMessage1, restoreWorktree); } finally { forgettingRef.current = false; setForgetting(false); }
    };

    const renderMessageBody = () => {
      const renderResponse = () => <Markdown onOpenFile={componentProps.onOpenFile} streaming={streaming()}>{output()}</Markdown>;
      const renderMessageFailure = () => (failureState().failure && <div class="message-failure" role="status"><CircleAlert size={14} /><span>{(failureState().failure)}</span>{componentProps.onRetry && <button disabled={(componentProps.retrying === undefined ? false : componentProps.retrying)} onClick={(componentProps.onRetry)}>{(componentProps.retrying === undefined ? false : componentProps.retrying) ? "Retrying…" : "Retry"}</button>}</div>);
      const renderStreamCaret = () => (streaming() && <span class="stream-caret" />);

      const renderMessageActions = () => {
        const renderToolFailureRate = () => componentProps.debug && <ToolFailureMeter stats={componentProps.toolFailures} />;
        const renderCopyResponse = () => (<IconButton title="Copy" label={copyState() === "copied" ? `${metadata().responseLabel} copied` : copyState() === "error" ? `Copy failed for ${metadata().responseLabel.toLowerCase()}` : `Copy ${metadata().responseLabel.toLowerCase()}`} onClick={copy}>{copyState() === "copied" ? <Check size={14} /> : copyState() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>);
        const renderBranchAction = () => (componentProps.onBranch && <button class="branch-button" aria-label="Fork" title="Fork" disabled={branching() || forgetting()} onClick={() => void branch()}><Split size={14} /></button>);
        const renderForkAndForgetAction = () => (componentProps.onForkAndForget && <button class="branch-button fork-and-forget-button" aria-label={`Fork and forget from ${metadata().responseLabel.toLowerCase()}`} title="Fork from here and archive original chat" disabled={branching() || forgetting()} onClick={() => void forkAndForget()}><Undo2 size={14} /></button>);
        const renderBranchAndForgetAction = () => (componentProps.canRollback && componentProps.onForkAndForget && <button class="branch-button rollback-and-forget-button" aria-label="Branch and forget from here" title="Branch from here into a new worktree and archive original chat" disabled={branching() || forgetting()} onClick={() => void forkAndForget(true)}><FolderGit2 size={14} /></button>);
        const renderCacheHitRate = () => ((componentProps.debug === undefined ? false : componentProps.debug) && metadata().cache && <span class={`cache-hit-rate${required((metadata().cache)).low ? " low" : ""}`} tabIndex={0} aria-label={`Cache ${required((metadata().cache)).rate}%, ${required((metadata().cache)).cachedTokens}/${required((metadata().cache)).promptTokens}`}>Cache {required((metadata().cache)).rate}%<span class="cache-fraction-tooltip" aria-hidden="true"><span>{cacheTokenDigits(required((metadata().cache)).cachedTokens)}</span><span>{cacheTokenDigits(required((metadata().cache)).promptTokens)}</span></span></span>);

        const showActions = () => (componentProps.showActions === undefined ? true : componentProps.showActions) && !streaming() && (output().trim().length > 0 || componentProps.message.stopReason === "aborted" || componentProps.onForkAndForget || componentProps.onCreateWorktree);

        return (showActions() && <div class="message-actions">
          {renderCopyResponse()}
          {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy response</span>}
          {renderBranchAction()}

          {componentProps.onCreateWorktree && <button class="branch-button" aria-label="Branch" title="Branch" onClick={() => required(componentProps.onCreateWorktree)(componentProps.message)}><FolderGit2 size={14} /></button>}
          {renderCacheHitRate()}
          {renderToolFailureRate()}
          {metadata().responseTime && <span class="message-time">{required((metadata().responseTime)).short}</span>}
          {renderForkAndForgetAction()}
          {renderBranchAndForgetAction()}
        </div>);
      };

      return (<div class="message-body">
        {thinking() && <div class="reasoning-text"><Markdown streaming={streaming()}>{thinking()}</Markdown></div>}
        {renderResponse()}
        {renderMessageFailure()}
        {failureState().pausedResponse && <div class="message-paused" role="status"><Pause size={14} /><span>Response paused</span></div>}
        {renderStreamCaret()}
        {componentProps.diff && <DiffViewer {...(componentProps.diff)} />}
        {renderMessageActions()}
      </div>);
    };

    return (<article class={`message assistant-message ${thinking() ? "reasoning-message" : ""}`} aria-label={metadata().responseLabel}>
      {renderMessageBody()}
    </article>);
  };

  return <>{componentProps.message.customType === "piop-agent-message" ? <AgentDelivery message={componentProps.message} /> : isContextInjection(componentProps.message) ? <details class="context-injection"><summary>{componentProps.message.customType === "pi-project-files-watch" ? "Project files changed" : "Context added"}<ChevronRight size={12} aria-hidden="true" /></summary><div class="context-injection-content">{textOf(componentProps.message.content)}</div></details> : componentProps.message.customType === "piop-html-preview" ? <HtmlPreview details={componentProps.message.details} /> : componentProps.message.customType === "piop-subagent-result" ? <SubagentResults runs={subagentRuns(componentProps.message.details)} /> : componentProps.message.customType === "piop-review-link" ? <ReviewLink details={componentProps.message.details} /> : componentProps.message.role === "system" ? (<div class="command-result" role="status">{textOf(componentProps.message.content)}</div>) : componentProps.message.role === "tool" ? (<ToolResult message={componentProps.message} toolCount={(componentProps.toolCount === undefined ? 1 : componentProps.toolCount)} debug={(componentProps.debug === undefined ? false : componentProps.debug)} />) : componentProps.message.role === "user" ? (<UserMessage />) : (renderAssistantMessage())}</>;
}
