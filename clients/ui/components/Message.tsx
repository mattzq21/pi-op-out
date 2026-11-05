import { z, type JSONType } from "zod";
import { required } from "../lib/required";
import { Dynamic } from "solid-js/web";
import { pluginMessageRenderer } from "../plugins/clientModules";
import { ConversationHostContext } from "../lib/subagentNavigation";
import { AgentDelivery } from "./AgentDelivery";
import { GoalPrompt } from "./GoalPrompt";
import { Key } from "@solid-primitives/keyed";
import { type Accessor, createMemo, createSignal, Index, onCleanup, Show, useContext } from "solid-js";
import { formatDuration, formatElapsed } from "../lib/duration";
import { ConversationImageProject } from "./markdownImages";
import { createDependencyEffect, createRef } from "../lib/solid";

import { Check, ChevronRight, CircleAlert, Copy, GitBranch, Pencil, Pin, Split, Wrench } from "lucide-solid";
import { MessagePinContext, pinId, pinText } from "../lib/messagePins";
import { hasVisibleText, textOf, thinkingOf } from "../lib/content";
import { cacheHitStats, GOAL_PROMPT, isContextInjection, toolTitle } from "../lib/messages";
import { CacheIcon } from "./CacheIcon";
import type { ChatMessage } from "../types";
import { IconButton } from "./IconButton";
import { Markdown } from "./Markdown";
import { ImageGallery, ZoomableImage } from "./ZoomableImage";
import { showsSubagents, SubagentResults, subagentRuns, toolSubagentRuns } from "./SubagentResults";
import { copyText } from "../lib/clipboard";
import { sentSkillPrompt } from "../lib/composerPrompt";
import type { DebugView } from "../lib/debugFeatures";
import { formatDateTime, formatDayTime, formatTime } from "../lib/dateTime";
import { SentMessageEditor, type EditSentMessage } from "./SentMessageEditor";

interface Props { message: ChatMessage; turnCacheUsage?: { input: number; cacheRead: number }; expanded?: boolean; showActions?: boolean; toolCount?: number; debug?: DebugView; onBranch?: (message: ChatMessage) => void | Promise<void>; onFork?: (message: ChatMessage) => void | Promise<void>; onEdit?: EditSentMessage; onRetry?: () => void; retrying?: boolean; lastPoint?: boolean; }

function cacheTokenDigits(tokens: number) {
  const groups = String(tokens).match(/\d{1,3}(?=(?:\d{3})*$)/g) ?? [];

  return groups.map((group, index) => <span style={{ color: "var(--accent)", opacity: [0.33, 0.66, 1][Math.min(2, groups.length - index - 1)] }}>{group}</span>);
}

function createForkActions(props: Props) {
  const [running, setRunning] = createSignal(false);
  const runningRef = createRef(false);
  const run = async (action: Props["onFork"]) => { const message = props.message;

    if (!action || runningRef.current) return;
    runningRef.current = true; setRunning(true);

    try { await action(message); } finally { runningRef.current = false; setRunning(false); }
  };

  return {
    available: () => Boolean(props.onFork || props.onBranch),
    fork: () => <Show when={props.onFork}><button class="branch-button" aria-label="Fork" data-tooltip="Fork" disabled={running()} onClick={() => void run(props.onFork)}><Split size={14} /></button></Show>,
    branch: () => <Show when={props.onBranch}><button class="branch-button" aria-label="Branch off" data-tooltip="Branch off" disabled={running()} onClick={() => void run(props.onBranch)}><GitBranch size={14} /></button></Show>,
  };
}

function userMessageParts(content: string) {
  const goal = content.match(/^\/goal(?:\s+([\s\S]*))?$/);

  if (goal) return { command: "goal", text: (goal[1] ?? "").trim(), literalSkill: false };
  const call = sentSkillPrompt(content);

  return call ? { skills: call.skills, text: call.text, literalSkill: false } : { text: content, literalSkill: /<\/?skill\b/i.test(content) };
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

function PinButton(props: { message: ChatMessage; text: string }) {
  const pins = useContext(MessagePinContext);
  const [busy, setBusy] = createSignal(false);

  return <Show when={props.message.timestamp !== undefined && pins}>{owner => {
    const pinned = () => owner().pinned(pinId(props.message));
    const toggle = () => {
      if (busy()) return;
      setBusy(true);
      void owner().toggle(props.message, props.text).finally(() => setBusy(false));
    };

    return <button type="button" class="message-pin" classList={{ pinned: pinned() }} aria-pressed={pinned()} aria-label={pinned() ? "Unpin message" : "Pin message"} data-tooltip={pinned() ? "Unpin" : "Pin"} disabled={busy()} onClick={toggle}><Pin size={17} /></button>;
  }}</Show>;
}

function formatMessageTime(timestamp?: number) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return undefined;

  const age = Date.now() - timestamp;

  return {
    short: age < 24 * 60 * 60 * 1000
      ? formatTime(date)
      : age < 365 * 24 * 60 * 60 * 1000
        ? formatDayTime(date)
        : formatDateTime(date),
    full: formatDateTime(date),
  };
}

function responseFailure(message: ChatMessage) {
  const failure = message.stopReason === "aborted" ? (message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted") : message.stopReason === "error" ? `Response failed: ${message.errorMessage || "Unknown error"}` : undefined;

  return { failure };
}

function responseMetadata(message: Accessor<ChatMessage>, turnCacheUsage: Accessor<Props['turnCacheUsage']>) {
  const timestamp = createMemo(() => message().timestamp);
  const completedAt = createMemo(() => message().completedAt ?? timestamp());
  const id = createMemo(() => message().id);
  const responseLabel = createMemo(() => `Assistant response${timestamp() ? ` from ${formatDateTime(new Date(required(timestamp())))}` : ` ${id().slice(0, 8)}`}`);
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
  return <>{componentProps.message.toolName !== "codemode" && <Wrench size={14} />}<span><strong>{toolTitle(componentProps.message)}{componentProps.toolCount > 1 ? ` x${componentProps.toolCount}` : ""}</strong><small>{componentProps.status === "running" ? "Running…" : componentProps.status === "error" ? "Failed" : componentProps.status === "unfinished" ? "Unfinished" : "Completed"}</small><Show when={componentProps.status === "running" && componentProps.message.timestamp}>{startedAt => <ToolElapsed startedAt={startedAt()} />}</Show></span></>;
}

function ToolElapsed(componentProps: { startedAt: number }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  return <small class="tool-elapsed" aria-label="Running time">{formatDuration(now() - componentProps.startedAt)}</small>;
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
  const runs = createMemo(() => showsSubagents(componentProps.message.toolName) ? toolSubagentRuns(componentProps.message.subagents) : []);
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal(0);
  let nextLoadAt = 0;
  let failed: { version?: number; retry: number } | undefined;
  let evictedAt: number | undefined;
  createDependencyEffect(() => {
    const retryAttempt = retry();
    if (failed && (failed.version !== componentProps.message.toolPayloadVersion || failed.retry !== retryAttempt)) failed = undefined;

    if (!open()) return;
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
  }, () => [open(), retry(), componentProps.message.toolPayloadVersion, componentProps.message.loadedToolPayloadVersion, componentProps.message.toolPayloadLoaded, componentProps.message.toolPayloadEvicted, componentProps.message.loadToolPayload]);
  const status = createMemo(() => (componentProps.status ?? componentProps.message.toolStatus ?? "done"));
  const label = createMemo(() => (<ToolLabel message={componentProps.message} toolCount={componentProps.toolCount ?? 1} status={status()} />));

  return <>{!componentProps.debug && !isSubagent() ? (<div class={`tool-event ${status()}`}><div class="tool-summary">{label()}</div></div>) : (<details class={`tool-event ${status()}`} open={open()} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="tool-summary">{label()}<ChevronRight size={12} class="tool-chevron" aria-hidden="true" /></summary>
    {open() && <ToolPayload message={componentProps.message} loading={loading()} error={error()} retry={() => setRetry((value) => value + 1)} />}
  </details>)}
    {runs().length > 0 && <SubagentResults runs={runs()} />}
  </>;
}

export function Message(componentProps: Props) {
  const imageProject = useContext(ConversationImageProject);
  const conversationHost = useContext(ConversationHostContext);
  const pluginView = () => pluginMessageRenderer(conversationHost?.() ?? "local", componentProps.message.customType);
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "error">("idle");

  const copy = async (value?: string) => { const capturedMessage0 = componentProps.message;

    try {
      await copyText(value ?? textOf(capturedMessage0.content));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    window.setTimeout(() => setCopyState("idle"), 1800);
  };

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
    const pinLabel = createMemo(() => pinText([parts().command ? "/" + parts().command : "", parts().text].filter(Boolean).join(" ")));
    const hasBody = () => Boolean(parts().text || parts().command);
    const [editing, setEditing] = createSignal(false);
    const editable = () => Boolean(componentProps.onEdit) && parts().command !== "goal";

    return <><ImageGallery><article tabIndex={-1} class={`message user-message${componentProps.message.deliveryBehavior === "steer" ? " steering-message" : ""}`} classList={{ editing: editing() }} data-pin-id={pinId(componentProps.message)}>
      <Show when={!editing()} fallback={<SentMessageEditor message={componentProps.message} text={imageContext().text} onSave={componentProps.onEdit} onClose={() => setEditing(false)} />}>
      {images().length > 0 && <div class="user-message-images">{!hasBody() && <PinButton message={componentProps.message} text={pinLabel()} />}<Index each={images()}>{part => <ZoomableImage src={`data:${part().mimeType};base64,${part().data}`} alt="Sent attachment" />}</Index></div>}
      {hasBody() && <div class="message-body"><PinButton message={componentProps.message} text={pinLabel()} />
      <Show when={parts().command}>{command => <span class="skill-reference command-reference">/{command()}</span>}</Show><Show when={parts().text}><Show when={parts().literalSkill} fallback={<Markdown frontmatter skills={parts().skills}>{parts().text}</Markdown>}><span class="literal-skill-content">{parts().text}</span></Show></Show>
      </div>}
      <div class="message-actions">
        {sentTime() && <span class="message-time">{required(sentTime()).short}</span>}
        <Show when={hasVisibleText(textOf(componentProps.message.content))}><MessageCopyButton state={copyState()} copy={() => { const content = textOf(componentProps.message.content);

          return copy(sentSkillPrompt(content)?.text ?? content); }} /></Show>
        {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy message</span>}
        <Show when={editable()}><IconButton title="Edit" label="Edit message" onClick={() => setEditing(true)}><Pencil size={14} /></IconButton></Show>
      </div>
      </Show>
    </article></ImageGallery>{componentProps.debug?.contextInjections && imageContext().notes && <ContextInjection title="Image context" content={imageContext().notes} />}</>;
  };

  const renderAssistantMessage = () => {
    const output = createMemo(() => (textOf(componentProps.message.content)));
    const thinking = createMemo(() => (thinkingOf(componentProps.message.content)));
    const streaming = createMemo(() => componentProps.message.streaming);
    const metadata = responseMetadata(() => componentProps.message, () => componentProps.turnCacheUsage);
    const failureState = createMemo(() => (responseFailure(componentProps.message)));
    const forkActions = createForkActions(componentProps);

    const renderMessageBody = () => {
      const renderResponse = () => <Markdown imageProject={imageProject()} fileLinks streaming={streaming()}>{output()}</Markdown>;
      const renderMessageFailure = () => (failureState().failure && <div class="message-failure" role="status"><CircleAlert size={14} /><span>{(failureState().failure)}</span>{componentProps.onRetry && <button disabled={(componentProps.retrying === undefined ? false : componentProps.retrying)} onClick={(componentProps.onRetry)}>{(componentProps.retrying === undefined ? false : componentProps.retrying) ? "Retrying…" : "Retry"}</button>}</div>);

      const renderMessageActions = () => {
        const renderCopyResponse = () => (<IconButton title="Copy" label={copyState() === "copied" ? `${metadata().responseLabel} copied` : copyState() === "error" ? `Copy failed for ${metadata().responseLabel.toLowerCase()}` : `Copy ${metadata().responseLabel.toLowerCase()}`} onClick={() => void copy()}>{copyState() === "copied" ? <Check size={14} /> : copyState() === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}</IconButton>);
        const renderCacheHitRate = () => ((componentProps.debug?.cacheHitRate ?? false) && metadata().cache && <span class={`cache-hit-rate${required((metadata().cache)).low ? " low" : ""}`} tabIndex={0} aria-label={`Cache ${required((metadata().cache)).rate}%, ${required((metadata().cache)).cachedTokens}/${required((metadata().cache)).promptTokens}`}><CacheIcon rate={required((metadata().cache)).rate} /><span class="cache-rate-value">{required((metadata().cache)).rate}%</span><span class="cache-fraction-tooltip" aria-hidden="true"><span>{cacheTokenDigits(required((metadata().cache)).cachedTokens)}</span><span>{cacheTokenDigits(required((metadata().cache)).promptTokens)}</span></span></span>);

        const showActions = () => (componentProps.showActions === undefined ? true : componentProps.showActions) && !streaming() && (output().trim().length > 0 || componentProps.message.stopReason === "aborted" || forkActions.available());

        return (<Show when={showActions()}><div class="message-actions">
          <Show when={hasVisibleText(output())}>{renderCopyResponse()}</Show>
          {copyState() === "error" && <span class="copy-feedback" role="status">Could not copy response</span>}
          {forkActions.fork()}
          {forkActions.branch()}

          {renderCacheHitRate()}
          <Show when={metadata().responseTime}>{time => <span class="message-time">{time().short}</span>}</Show>
        </div></Show>);
      };

      return (<div class="message-body">
        <Show when={(componentProps.showActions ?? true) && !streaming() && hasVisibleText(output())}><PinButton message={componentProps.message} text={pinText(output())} /></Show>
        <Show when={thinking()}><div class="reasoning-text"><Markdown streaming={streaming()}>{thinking()}</Markdown></div></Show>
        {renderResponse()}
        {renderMessageFailure()}
        {renderMessageActions()}
      </div>);
    };

    return (<article tabIndex={-1} class={`message assistant-message ${thinking() ? "reasoning-message" : ""}`} classList={{ "last-point": componentProps.lastPoint === true }} data-response-id={componentProps.message.id} data-pin-id={pinId(componentProps.message)} aria-label={metadata().responseLabel}>
      {renderMessageBody()}
    </article>);
  };

  const renderToolMessage = () => (<ToolResult message={componentProps.message} toolCount={(componentProps.toolCount === undefined ? 1 : componentProps.toolCount)} debug={componentProps.debug?.toolDetails ?? false} />);

  const renderCompaction = () => {
    const forkActions = createForkActions(componentProps);
    const finishedTime = createMemo(() => formatMessageTime(componentProps.message.timestamp));
    const compactedFor = createMemo(() => formatElapsed(componentProps.message.startedAt, componentProps.message.timestamp));

    return <article tabIndex={-1} class="message compaction-message" classList={{ "last-point": componentProps.lastPoint === true }} aria-label="Compaction">
      <Show when={compactedFor()}><div class="compaction-duration">Compacted for {compactedFor()}</div></Show>
      <div class="command-result compaction" role="status">{textOf(componentProps.message.content)}</div>
      <Show when={forkActions.available() || finishedTime()}><div class="message-actions"><Show when={forkActions.available()}>{forkActions.fork()}{forkActions.branch()}</Show>{finishedTime() && <span class="message-time">{required(finishedTime()).short}</span>}</div></Show>
    </article>;
  };

  return <>{componentProps.message.customType === "piop-agent-message" ? <AgentDelivery message={componentProps.message} actions={renderSentActions} /> : componentProps.message.customType === GOAL_PROMPT ? <GoalPrompt message={componentProps.message} /> : isContextInjection(componentProps.message) ? <ContextInjection title={componentProps.message.customType === "pi-project-files-watch" ? "Project files changed" : "Context added"} content={textOf(componentProps.message.content)} /> : componentProps.message.customType === "piop-subagent-result" ? <SubagentResults runs={subagentRuns(componentProps.message.details)} /> : pluginView() ? <Dynamic component={pluginView()} details={componentProps.message.details} /> : componentProps.message.role === "system" && componentProps.message.customType === "compaction" ? renderCompaction() : componentProps.message.role === "system" ? (<div class="command-result" role="status">{textOf(componentProps.message.content)}</div>) : componentProps.message.role === "tool" ? renderToolMessage() : componentProps.message.role === "user" ? (<UserMessage />) : (renderAssistantMessage())}</>;
}
