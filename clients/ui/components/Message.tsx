import { z, type JSONType } from "zod";
import { required } from "../lib/required";
import { Dynamic } from "solid-js/web";
import { pluginMessageRenderer } from "../plugins/messages";
import { AgentDelivery } from "./AgentDelivery";
import { Key } from "@solid-primitives/keyed";
import { type Accessor, createMemo, createSignal, Index, Show, useContext } from "solid-js";
import { ConversationImageProject } from "./markdownImages";
import { createDependencyEffect, createRef } from "../lib/solid";

import { Check, ChevronRight, CircleAlert, Copy, Pause, GitBranch, Split, Undo2, Wrench } from "lucide-solid";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats, isContextInjection } from "../lib/messages";
import { CacheIcon } from "./CacheIcon";
import type { ChatMessage } from "../types";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import { ZoomableImage } from "./ZoomableImage";
import { SubagentResults, subagentRuns } from "./SubagentResults";
import { copyText } from "../lib/clipboard";
import type { DebugView } from "../lib/debugFeatures";

interface Props { message: ChatMessage; turnCacheUsage?: { input: number; cacheRead: number }; expanded?: boolean; showActions?: boolean; toolCount?: number; debug?: DebugView; paused?: boolean; onBranch?: (message: ChatMessage) => void | Promise<void>; onFork?: (message: ChatMessage) => void | Promise<void>; onForkAndForget?: (message: ChatMessage) => void | Promise<void>; onRetry?: () => void; retrying?: boolean; }

function cacheTokenDigits(tokens: number) {
  const groups = String(tokens).match(/\d{1,3}(?=(?:\d{3})*$)/g) ?? [];

  return groups.map((group, index) => <span style={{ color: "var(--accent)", opacity: [0.33, 0.66, 1][Math.min(2, groups.length - index - 1)] }}>{group}</span>);
}

function userMessageParts(content: string) {
  const goal = content.match(/^\/goal(?:\s+([\s\S]*))?$/);

  if (goal) return { command: "goal", skills: [] satisfies string[], text: (goal[1] ?? "").trim(), literalSkill: false };
  const invocation = content.match(/^<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?<\/skill>(?:\n\n([\s\S]*))?$/i);

  if (!invocation) return { skills: [] satisfies string[], text: content, literalSkill: /<\/?skill\b/i.test(content) };

  return { skills: [invocation[1]], text: (invocation[2] ?? "").trim(), literalSkill: false };
}

function imageContextParts(content: string, hasImages: boolean) {
  const lines = content.trimEnd().split("\n");
  const notes: string[] = [];

  if (hasImages) while (lines.length) {
    const line = lines[lines.length - 1];

    if (!line.trim() && notes.length) { lines.pop(); continue; }

    if (!/^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/.test(line)) break;
    notes.unshift(line);
    lines.pop();
  }

  return { text: notes.length ? lines.join("\n").trimEnd() : content, notes: notes.join("\n\n") };
}

function ContextInjection(props: { title: string; content: string }) {
  return <details class="context-injection"><summary>{props.title}<ChevronRight size={12} aria-hidden="true" /></summary><div class="context-injection-content">{props.content}</div></details>;
}

const shortMessageTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const recentMessageTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const fullMessageTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatMessageTime(timestamp?: number) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return undefined;

  const age = Date.now() - timestamp;

  return {
    short: age < 24 * 60 * 60 * 1000
      ? shortMessageTime.format(date)
      : age < 365 * 24 * 60 * 60 * 1000
        ? recentMessageTime.format(date)
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
  const nestedStatus = (status: string) => status === "ok" ? "done" : status === "error" ? "error" : componentProps.message.toolStatus === "running" && !componentProps.message.nestedCalls?.complete ? "running" : "unfinished";

  const nestedCalls = () => componentProps.message.nestedCalls?.calls ?? [];

  const needsLoad = () => !componentProps.loading && !componentProps.error && componentProps.message.deferredToolPayload && !componentProps.message.toolPayloadLoaded;

  return <>
      {input() !== undefined && <div class="tool-payload"><div class="tool-payload-label">In</div><div class="tool-input" aria-label="Tool arguments"><pre>{(input())}</pre></div></div>}
      {nestedCalls().length > 0 && <div class="tool-payload nested-tool-calls" role="group" aria-label="Nested tool calls"><Key each={nestedCalls()} by={call => call.id}>{call => <ToolResult debug
        status={nestedStatus(call().status)}
        message={{ id: call().id, role: "tool", toolName: call().name, toolInput: call().arguments, content: call().error ?? "" }}
      />}</Key></div>}
      {output() && <div class="tool-payload"><div class="tool-payload-label">Out</div><div class="tool-output" aria-label="Tool output"><pre>{output()}</pre></div></div>}
    {componentProps.loading && <div role="status">Loading tool input and output…</div>}
    {componentProps.error && <div role="alert">{(componentProps.error)} <button onClick={componentProps.retry}>Retry</button></div>}
    {Array.isArray(componentProps.message.content) && <Index each={componentProps.message.content.filter((part) => part.type === "image")}>{(part) => part().type === "image" && part().data && /^image\/(png|jpeg|gif|webp)$/.test(part().mimeType ?? "") ? <ZoomableImage src={`data:${part().mimeType};base64,${part().data}`} alt="Tool result" /> : null}</Index>}
    {needsLoad() && <button onClick={componentProps.retry}>Load input and output</button>}
  </>;
}

function ToolResult(componentProps: Pick<Props, "message" | "toolCount"> & { debug?: boolean;  status?: "running" | "done" | "error" | "unfinished" }) {
  const isSubagent = () => componentProps.message.toolName === "spawn_subagents";
  // spawn_subagents shows the subagents it started; await_subagents shows the ones whose answers it returned.
  const runs = createMemo(() => ["spawn_subagents", "await_subagents"].includes(componentProps.message.toolName ?? "") ? subagentRuns(componentProps.message.details) : []);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal(0);
  let nextLoadAt = 0;
  let failed: { version?: number; retry: number } | undefined;
  /** The retry count when the memory limit removed the payload. Only a later retry loads it again, so open outputs do not evict each other in a loop. */
  let evictedAt: number | undefined;
  createDependencyEffect(() => {
    const retryAttempt = retry();
    if (failed && (failed.version !== componentProps.message.toolPayloadVersion || failed.retry !== retryAttempt)) failed = undefined;

    if (!open() && !isSubagent()) return;
    let active = true; let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      const message = componentProps.message;

      if (!active || pending) return;

      if (message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion) {
        setLoading(false); setError(undefined);
        return;
      }

      if (message.toolPayloadEvicted) {
        evictedAt ??= retryAttempt;

        if (retryAttempt === evictedAt) { setLoading(false); return; }
      } else evictedAt = undefined;

      if (!message.loadToolPayload || failed && failed.version === message.toolPayloadVersion) return;
      const delay = nextLoadAt - Date.now();

      if (delay > 0) {
        setLoading(true); setError(undefined);
        clearTimeout(timer);
        timer = setTimeout(refresh, delay);
        return;
      }

      nextLoadAt = Date.now() + 300;
      pending = true;
      setLoading(true); setError(undefined);
      const version = message.toolPayloadVersion;
      void message.loadToolPayload().catch((reason) => { if (active) { failed = { version, retry: retryAttempt }; setError(reason instanceof Error ? reason.message : String(reason)); } })
        .finally(() => { pending = false;
        nextLoadAt = Date.now() + 300;

        if (active) { setLoading(false); refresh(); } });
    };

    refresh();

    return () => { active = false; clearTimeout(timer); };
  }, () => [open(), retry(), isSubagent(), componentProps.message.toolPayloadVersion, componentProps.message.loadedToolPayloadVersion, componentProps.message.toolPayloadLoaded, componentProps.message.toolPayloadEvicted, componentProps.message.loadToolPayload]);
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
  const imageProject = useContext(ConversationImageProject);
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "error">("idle");
  const [branching, setBranching] = createSignal(false);
  const branchingRef = createRef(false);
  const [forgetting, setForgetting] = createSignal(false);
  const forgettingRef = createRef(false);

  const copy = async (value?: string) => { const capturedMessage0 = componentProps.message;

    try {
      await copyText(value ?? textOf(capturedMessage0.content));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    window.setTimeout(() => setCopyState("idle"), 1800);
  };

  /** The time and copy bar under a message from another agent, the same as under a user message. */
  const renderSentActions = (sent: string) => {
    const sentTime = formatMessageTime(componentProps.message.timestamp);

    return <div class="message-actions">
      {sentTime && <span class="message-time">{sentTime.short}</span>}
      <Show when={hasVisibleText(sent)}><MessageCopyButton state={copyState()} copy={() => copy(sent)} /></Show>
      {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy message</span>}
    </div>;
  };

  const UserMessage = () => {
    const sentTime = createMemo(() => formatMessageTime(componentProps.message.timestamp));
    const images = createMemo(() => Array.isArray(componentProps.message.content) ? componentProps.message.content.flatMap(part => part.type === "image" && part.data && part.mimeType && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) ? [part] : []) : []);
    const imageContext = createMemo(() => imageContextParts(textOf(componentProps.message.content), images().length > 0));
    const parts = createMemo(() => userMessageParts(imageContext().text));

    return <><article class={`message user-message${componentProps.message.deliveryBehavior === "steer" ? " steering-message" : ""}`}>
      {images().length > 0 && <div class="user-message-images"><Index each={images()}>{part => <ZoomableImage src={`data:${part().mimeType};base64,${part().data}`} alt="Sent attachment" />}</Index></div>}
      {(parts().text || parts().skills.length > 0 || parts().command) && <div class="message-body">
      <Show when={parts().command}>{command => <span class="skill-reference command-reference">/{command()}</span>}</Show>{<Key each={parts().skills} by={(skill) => skill}>{(skill, _index) => <span class="skill-reference" >${skill()}</span>}</Key>}{parts().text && (parts().literalSkill ? <span class="literal-skill-content">{parts().text}</span> : <Markdown>{parts().text}</Markdown>)}
      </div>}
      <div class="message-actions">
        {sentTime() && <span class="message-time">{required(sentTime()).short}</span>}
        <Show when={hasVisibleText(textOf(componentProps.message.content))}><MessageCopyButton state={copyState()} copy={() => copy()} /></Show>
        {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy message</span>}
      </div>
    </article>{imageContext().notes && <ContextInjection title="Image context" content={imageContext().notes} />}</>;
  };

  const renderAssistantMessage = () => {
    const output = createMemo(() => (textOf(componentProps.message.content)));
    const thinking = createMemo(() => (thinkingOf(componentProps.message.content)));
    const streaming = createMemo(() => componentProps.message.streaming);
    const metadata = responseMetadata(() => componentProps.message, () => componentProps.turnCacheUsage);
    const failureState = createMemo(() => (responseFailure(componentProps.message, (componentProps.paused === undefined ? false : componentProps.paused))));

    const branch = async (worktree = false) => { const capturedOnBranch0 = worktree ? componentProps.onBranch : componentProps.onFork; const capturedMessage1 = componentProps.message;

      if (!capturedOnBranch0 || branchingRef.current || forgettingRef.current) return;
      branchingRef.current = true; setBranching(true);

      try { await (capturedOnBranch0)(capturedMessage1); } finally { branchingRef.current = false; setBranching(false); }
    };

    const forkAndForget = async () => { const capturedOnForkAndForget0 = componentProps.onForkAndForget; const capturedMessage1 = componentProps.message;

      if (!capturedOnForkAndForget0 || branchingRef.current || forgettingRef.current) return;
      forgettingRef.current = true; setForgetting(true);

      try { await (capturedOnForkAndForget0)(capturedMessage1); } finally { forgettingRef.current = false; setForgetting(false); }
    };

    const renderMessageBody = () => {
      const renderResponse = () => <Markdown imageProject={imageProject()} fileLinks streaming={streaming()}>{output()}</Markdown>;
      const renderMessageFailure = () => (failureState().failure && <div class="message-failure" role="status"><CircleAlert size={14} /><span>{(failureState().failure)}</span>{componentProps.onRetry && <button disabled={(componentProps.retrying === undefined ? false : componentProps.retrying)} onClick={(componentProps.onRetry)}>{(componentProps.retrying === undefined ? false : componentProps.retrying) ? "Retrying…" : "Retry"}</button>}</div>);

      const renderMessageActions = () => {
        const renderCopyResponse = () => (<IconButton title="Copy" label={copyState() === "copied" ? `${metadata().responseLabel} copied` : copyState() === "error" ? `Copy failed for ${metadata().responseLabel.toLowerCase()}` : `Copy ${metadata().responseLabel.toLowerCase()}`} onClick={() => void copy()}>{copyState() === "copied" ? <Check size={14} /> : copyState() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>);
        const renderForkAction = () => (componentProps.onFork && <button class="branch-button" aria-label="Fork" data-tooltip="Fork" disabled={branching() || forgetting()} onClick={() => void branch()}><Split size={14} /></button>);
        const renderBranchAction = () => (componentProps.onBranch && <button class="branch-button" aria-label="Branch off" data-tooltip="Branch off" disabled={branching() || forgetting()} onClick={() => void branch(true)}><GitBranch size={14} /></button>);
        const renderForkAndForgetAction = () => (componentProps.onForkAndForget && <button class="branch-button fork-and-forget-button" aria-label={`Fork and forget from ${metadata().responseLabel.toLowerCase()}`} data-tooltip="Fork and forget" disabled={branching() || forgetting()} onClick={() => void forkAndForget()}><Undo2 size={14} /></button>);
        const renderCacheHitRate = () => ((componentProps.debug?.cacheHitRate ?? false) && metadata().cache && <span class={`cache-hit-rate${required((metadata().cache)).low ? " low" : ""}`} tabIndex={0} aria-label={`Cache ${required((metadata().cache)).rate}%, ${required((metadata().cache)).cachedTokens}/${required((metadata().cache)).promptTokens}`}><CacheIcon rate={required((metadata().cache)).rate} />{required((metadata().cache)).rate}%<span class="cache-fraction-tooltip" aria-hidden="true"><span>{cacheTokenDigits(required((metadata().cache)).cachedTokens)}</span><span>{cacheTokenDigits(required((metadata().cache)).promptTokens)}</span></span></span>);

        const showActions = () => (componentProps.showActions === undefined ? true : componentProps.showActions) && !streaming() && (output().trim().length > 0 || componentProps.message.stopReason === "aborted" || componentProps.onForkAndForget);

        return (showActions() && <div class="message-actions">
          {renderCopyResponse()}
          {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy response</span>}
          {renderForkAction()}
          {renderBranchAction()}

          {renderCacheHitRate()}
          {metadata().responseTime && <span class="message-time">{required((metadata().responseTime)).short}</span>}
          {renderForkAndForgetAction()}
        </div>);
      };

      return (<div class="message-body">
        {thinking() && <div class="reasoning-text"><Markdown streaming={streaming()}>{thinking()}</Markdown></div>}
        {renderResponse()}
        {renderMessageFailure()}
        {failureState().pausedResponse && <div class="message-paused" role="status"><Pause size={14} /><span>Response paused</span></div>}
        {renderMessageActions()}
      </div>);
    };

    return (<article class={`message assistant-message ${thinking() ? "reasoning-message" : ""}`} data-response-id={componentProps.message.id} aria-label={metadata().responseLabel}>
      {renderMessageBody()}
    </article>);
  };

  const renderToolMessage = () => (<ToolResult message={componentProps.message} toolCount={(componentProps.toolCount === undefined ? 1 : componentProps.toolCount)} debug={componentProps.debug?.toolDetails ?? false} />);

  return <>{componentProps.message.customType === "piop-agent-message" ? <AgentDelivery message={componentProps.message} actions={renderSentActions} /> : isContextInjection(componentProps.message) ? <ContextInjection title={componentProps.message.customType === "pi-project-files-watch" ? "Project files changed" : "Context added"} content={textOf(componentProps.message.content)} /> : componentProps.message.customType === "piop-subagent-result" ? <SubagentResults runs={subagentRuns(componentProps.message.details)} /> : pluginMessageRenderer(componentProps.message.customType) ? <Dynamic component={pluginMessageRenderer(componentProps.message.customType)} details={componentProps.message.details} /> : componentProps.message.role === "system" ? (<div class="command-result" role="status">{textOf(componentProps.message.content)}</div>) : componentProps.message.role === "tool" ? renderToolMessage() : componentProps.message.role === "user" ? (<UserMessage />) : (renderAssistantMessage())}</>;
}
