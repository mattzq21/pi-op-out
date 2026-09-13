import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

const MESSAGE_TIMEOUT_MS = 120_000;

type StoppedAssistantMessage = AssistantMessage & { piopCompletedBlocks?: true };

export function desktopPauseContext(messages: ContextEvent["messages"], resumeMessages: ReadonlySet<string>): ContextEvent["messages"] {
  return messages.filter((message) => !(message.role === "assistant" && message.stopReason === "aborted" && message.errorMessage === "Response paused")).map((message) => {
    if (message.role === "assistant" && message.stopReason === "aborted" && (message as StoppedAssistantMessage).piopCompletedBlocks && message.content.length) {
      const content = message.content.flatMap<AssistantMessage["content"][number]>((block) => {
        if (block.type !== "thinking" || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(message.api)) return [block];
        try {
          const signature = JSON.parse(block.thinkingSignature ?? "null");
          if (signature?.type === "reasoning" && typeof signature.encrypted_content === "string" && signature.encrypted_content.trim()) return [block];
        } catch { /* A stopped stream may not have finalized its replay metadata. */ }
        return !block.redacted && block.thinking.trim() ? [{ type: "text", text: block.thinking }] : [];
      });
      if (!content.length) return message;
      return {
        ...message,
        stopReason: "stop" as const,
        errorMessage: undefined,
        content: [...content, { type: "text" as const, text: "[Response stopped by the user. Only completed content blocks are retained. Any tool calls in this response were not executed.]" }],
      };
    }
    if (message.role !== "user") return message;
    const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return resumeMessages.has(text) ? { ...message, content: [{ type: "text" as const, text: "Continue the previous task using the completed turns and tool results already in context. The last run was paused by the user. Check the current state of any interrupted work before continuing, and finish the remaining task without repeating completed work." }] } : message;
  });
}

async function cancelRequest(requestId: string) {
  if (!url || !token) return;
  await fetch(`${url}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
}

async function request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000) {
  if (!url || !token) throw new Error("piop session broker is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${url}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const result = await response.json() as { error?: string; data?: unknown };
    if (!response.ok || result.error) throw new Error(result.error || `Session broker returned HTTP ${response.status}`);
    return result.data;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export interface PauseController {
  state(): { isPaused: boolean; isPausing: boolean };
  pause(ctx: ExtensionContext): Promise<void>;
  resume(ctx: ExtensionContext): string | undefined;
  stop(ctx: ExtensionContext): Promise<void>;
}

export function registerPauseControl(pi: ExtensionAPI): PauseController {
  const probe: { controller?: PauseController } = {};
  pi.events.emit("pi-desktop:pause-controller", probe);
  if (probe.controller) return probe.controller;
  const pauseEntry = "pi-desktop-pause-state";
  const resumeEntry = "pi-desktop-resume";
  let isPaused = false;
  let isPausing = false;
  let pauseStopped = false;
  let pauseOperation: Promise<void> | undefined;
  let controlContext: ExtensionContext | undefined;
  const resumeMessages = new Set<string>();
  const completedBlocks = new Map<number, AssistantMessage["content"][number]>();
  let generation = 0;
  const publishPause = () => {
    controlContext?.ui.setStatus(pauseEntry, `json:${JSON.stringify({ type: "pause_state", isPaused, isPausing })}`);
  };
  const persistPause = (paused: boolean) => { isPaused = paused; pi.appendEntry(pauseEntry, { isPaused: paused }); };
  const restorePause = (ctx: ExtensionContext) => {
    generation += 1; controlContext = ctx;
    isPaused = false; isPausing = false; pauseStopped = false; resumeMessages.clear(); completedBlocks.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === pauseEntry) isPaused = (entry.data as { isPaused?: boolean } | undefined)?.isPaused === true;
      if (entry.customType === resumeEntry) { const message = (entry.data as { message?: string } | undefined)?.message; if (typeof message === "string") resumeMessages.add(message); }
    }
    publishPause();
  };
  pi.on("session_start", (_event, ctx) => { restorePause(ctx); });
  pi.on("session_tree", (_event, ctx) => { restorePause(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    // Pi can restart its agent loop to drain queued messages after an abort.
    // Keep those runs aborted until every queued message (including images) is saved.
    if (isPausing) { ctx.abort(); return; }
    if (isPaused) { persistPause(false); publishPause(); }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") completedBlocks.clear();
  });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type !== "text_end" && update.type !== "thinking_end" && update.type !== "toolcall_end") return;
    const block = update.partial.content[update.contentIndex];
    if (block) completedBlocks.set(update.contentIndex, structuredClone(block));
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const content = [...completedBlocks].sort(([left], [right]) => left - right).map(([, block]) => block);
    completedBlocks.clear();
    if (isPausing && (event.message.stopReason === "aborted" || (event.message.stopReason === "error" && ctx.signal?.aborted))) return { message: { ...event.message, stopReason: "aborted", errorMessage: "Response paused" } };
    if (event.message.stopReason === "aborted") {
      const message: StoppedAssistantMessage = { ...event.message, content, piopCompletedBlocks: true };
      return { message };
    }
  });
  pi.on("context", (event) => ({ messages: desktopPauseContext(event.messages, resumeMessages) }));
  const waitForIdle = async (ctx: ExtensionContext, version: number) => {
    while (version === generation && !ctx.isIdle()) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const controller: PauseController = {
    state: () => ({ isPaused, isPausing }),
    pause(ctx) {
      controlContext = ctx;
      if (!pauseOperation && !isPaused) {
        const version = generation;
        pauseStopped = false; isPausing = true; persistPause(true); isPaused = false; publishPause();
        pauseOperation = (async () => {
          try { ctx.abort(); await waitForIdle(ctx, version); }
          finally { if (version === generation) { isPaused = !pauseStopped; isPausing = false; pauseOperation = undefined; publishPause(); } }
        })();
      }
      return pauseOperation ?? Promise.resolve();
    },
    resume(ctx) {
      controlContext = ctx;
      if (isPausing || !ctx.isIdle()) throw new Error("Wait for Pi to finish pausing before resuming");
      if (!isPaused) return undefined;
      const message = `/pi-desktop-resume-turn ${crypto.randomUUID()}`;
      resumeMessages.add(message); pi.appendEntry(resumeEntry, { message });
      return message;
    },
    async stop(ctx) {
      controlContext = ctx; pauseStopped = true;
      if (isPaused || isPausing) persistPause(false);
      publishPause(); ctx.abort(); await pauseOperation; await waitForIdle(ctx, generation);
    },
  };
  const unsubscribe = pi.events.on("pi-desktop:pause-controller", (value) => { (value as { controller?: PauseController }).controller = controller; });
  pi.on("session_shutdown", () => { generation += 1; unsubscribe(); pauseOperation = undefined; });
  pi.registerCommand("pi-desktop-control", {
    description: "Control piop pause and resume",
    async handler(args, ctx) {
      controlContext = ctx;
      let id: string | undefined;
      let action = "";
      let resumeMessage: string | undefined;
      try {
        const control = JSON.parse(args) as { id?: string; action?: string }; id = control.id; action = control.action ?? "";
        if (!id || ctx.mode !== "rpc") throw new Error("Desktop control requires an RPC request");
        if (action === "pause") await controller.pause(ctx);
        else if (action === "resume") resumeMessage = controller.resume(ctx);
        else if (action === "stop") await controller.stop(ctx);
        else if (action !== "state") throw new Error(`Unknown desktop control: ${action}`);
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: true, data: { isPaused, isPausing, ...(resumeMessage ? { resumeMessage } : {}) } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  return controller;
}

export function registerFastModeStatus(pi: ExtensionAPI) {
  const packageName = "pi-openai-fast-mode";
  const statusKey = "pi-desktop-fast-mode";
  type FastConfig = { enabled: boolean; targets: Array<{ provider: string; model: string }> };
  let config: FastConfig | undefined;
  let loaded = false;
  let available = false;
  let queue = Promise.resolve();
  const publish = (ctx: ExtensionContext, model = ctx.model) => {
    const supported = config?.targets.some((target) => target.provider === model?.provider && target.model === model?.id && ["openai", "openai-codex"].includes(target.provider));
    const text = available && config && supported ? (config.enabled ? "Fast mode on" : "Fast mode off") : undefined;
    ctx.ui.setStatus(statusKey, text);
  };
  const refresh = async (ctx: ExtensionContext, reload: boolean) => {
    if (ctx.mode !== "rpc") return;
    if (!loaded || reload) {
      const command = pi.getCommands().find((command) => command.source === "extension" && /^fast(?::\d+)?$/.test(command.name) && (command.sourceInfo.source === `npm:${packageName}` || command.sourceInfo.path.split(/[\\/]/).includes(packageName)));
      available = Boolean(command); config = undefined;
      if (command) {
        const projectDir = resolve(ctx.cwd, ".pi");
        const extensionDir = resolve(dirname(command.sourceInfo.path));
        const projectConfig = join(projectDir, packageName, "config.json");
        const projectLocal = extensionDir === projectDir || extensionDir.startsWith(`${projectDir}${sep}`);
        const path = existsSync(projectConfig) || projectLocal ? projectConfig : join(getAgentDir(), "extensions", packageName, "config.json");
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as Partial<FastConfig>;
          if (typeof value.enabled === "boolean" && Array.isArray(value.targets) && value.targets.every((target) => target && typeof target.provider === "string" && typeof target.model === "string")) config = value as FastConfig;
        } catch { /* A missing or unreadable setting must not appear as disabled. */ }
      }
      loaded = true;
    }
    publish(ctx);
  };
  // The package only draws its indicator in TUI mode. Desktop asks after
  // startup and after /fast finishes writing its scoped configuration.
  // Keep that snapshot for model changes: another session may share the file
  // while each extension instance retains its own in-memory toggle.
  pi.registerCommand("pi-desktop-fast-status", { description: "Read Fast Mode status for piop", handler: (args, ctx) => {
    const next = queue.then(() => refresh(ctx, args.trim() === "refresh"));
    queue = next.catch(() => undefined);
    return next;
  } });
  pi.on("session_start", () => { loaded = false; config = undefined; available = false; });
  pi.on("model_select", (event, ctx) => { if (ctx.mode === "rpc" && loaded) publish(ctx, event.model); });
}

function registerForkAndForget(pi: ExtensionAPI) {
  const statusKey = "pi-desktop-control-response";
  pi.registerCommand("pi-desktop-fork-and-forget", {
    description: "Continue this session from an earlier assistant response",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args) as { id?: string; entryId?: string };
        id = request.id;
        if (!id || ctx.mode !== "rpc" || typeof request.entryId !== "string") throw new Error("Invalid fork-and-forget request");
        const entry = ctx.sessionManager.getEntry(request.entryId);
        if (!entry || entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Assistant response not found in this conversation");
        const result = await ctx.navigateTree(request.entryId);
        if (!result.cancelled) pi.appendEntry("pi-desktop-fork-and-forget", { entryId: request.entryId });
        ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: true, data: { cancelled: result.cancelled } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

const runFile = promisify(execFile);
const CATCH_UP_MESSAGE = "pi-desktop-catch-up";

function registerTurnCapture(pi: ExtensionAPI) {
  const script = process.env.PI_DESKTOP_GIT_CAPTURE_SCRIPT;
  if (!script) return;
  const publish = (ctx: ExtensionContext, capture: object) => ctx.ui.setStatus("pi-desktop-turn-capture", JSON.stringify(capture));
  const snapshot = async (cwd: string) => {
    try {
      const { stdout } = await runFile(process.execPath, ["-e", script], { cwd, maxBuffer: 64 * 1024 });
      const [root, tree] = stdout.trimEnd().split("\n");
      if (!root || !tree) throw new Error("Git snapshot was incomplete");
      return JSON.stringify({ root, tree });
    } catch (error) {
      if ([3, 4, 6].includes(Number((error as { code?: unknown }).code))) return null;
      throw error;
    }
  };
  let turn: { id: string; cwd: string; sessionId: string; entries: Set<string> } | undefined;
  const cancel = (ctx: ExtensionContext) => {
    if (turn) publish(ctx, { phase: "end", turnId: turn.id });
    turn = undefined;
  };
  pi.on("agent_start", async (_event, ctx) => {
    cancel(ctx);
    const started = { id: crypto.randomUUID(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), entries: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)) };
    try {
      // Pi awaits this hook before inference, including automatic queued continuations.
      const baseline = await snapshot(started.cwd);
      if (baseline) { turn = started; publish(ctx, { phase: "start", turnId: started.id, cwd: started.cwd, baseline }); }
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  });
  pi.on("agent_end", async (_event, ctx) => {
    const ended = turn; turn = undefined;
    if (!ended) return;
    let current: string | null = null;
    let messageId: string | undefined;
    const sessionPath = ctx.sessionManager.getSessionFile();
    try {
      if (ctx.sessionManager.getSessionId() !== ended.sessionId || !sessionPath) return;
      const response = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && !ended.entries.has(entry.id) && entry.message.role === "assistant" && (entry.message.content.some((part) => part.type === "text" && part.text.trim()) || ["aborted", "error"].includes(entry.message.stopReason)));
      if (!response) return;
      messageId = response.id;
      // Freeze the endpoint before Pi may start its next run; persistence uses only these trees.
      current = await snapshot(ended.cwd);
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { publish(ctx, { phase: "end", turnId: ended.id, cwd: ended.cwd, current, sessionPath, messageId }); }
  });
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}

export function registerCatchUp(pi: ExtensionAPI) {
  let running = false;
  const presenceId = crypto.randomUUID();
  const publishWorktree = (ctx: ExtensionContext, worktree: string | null) => ctx.ui.setStatus("pi-desktop-worktree-presence", JSON.stringify({ id: presenceId, worktree }));
  pi.on("session_start", async (_event, ctx) => {
    try {
      const { stdout } = await runFile("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
      publishWorktree(ctx, await realpath(stdout.trimEnd()));
    } catch { publishWorktree(ctx, null); }
  });
  const assertWorktreeIdle = async () => {
    const agents = await request("/worktree-agents", { id: presenceId }) as Array<{ sessionId?: string }>;
    if (agents.length) throw new Error(`Another Pi UI agent is working in this worktree${agents[0].sessionId ? ` (session ${agents[0].sessionId})` : ""}. Stop or pause it before catching up.`);
  };
  pi.registerCommand("catch-up", {
    description: "Reset this secondary worktree to the main worktree's commit (discards tracked changes)",
    async handler(args, ctx) {
      const report = (content: string) => pi.sendMessage({ customType: CATCH_UP_MESSAGE, content, display: true }, { triggerTurn: false });
      if (args.trim()) { report("Usage: /catch-up"); return; }
      if (running) { report("Catch-up is already running."); return; }
      if (!ctx.isIdle()) { report("Stop or pause the agent before running /catch-up."); return; }
      running = true;
      try {
        const git = async (cwd: string, ...args: string[]) => {
          const { stdout } = await runFile("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 });
          return stdout;
        };
        const root = (await git(ctx.cwd, "rev-parse", "--show-toplevel")).trimEnd();
        // Git lists the main worktree first. NUL delimiters preserve quoted paths.
        const first = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0\0")[0].split("\0");
        const main = first.find((field) => field.startsWith("worktree "))?.slice(9);
        if (!main || first.includes("bare")) throw new Error("No main working tree is available for this repository.");
        if (await realpath(root) === await realpath(main)) { report("Already in the main worktree. Nothing changed."); return; }
        await assertWorktreeIdle();
        const commit = (await git(main, "rev-parse", "--verify", "HEAD^{commit}")).trim();
        const confirmed = await ctx.ui.confirm("Catch up this worktree?", `Reset ${root} to the main worktree (${main}) at commit ${commit.slice(0, 12)}? This discards tracked local changes and moves the current branch to that commit. Uncommitted changes in the main worktree will not be copied.`);
        if (!confirmed) return;
        if (!ctx.isIdle()) throw new Error("Stop or pause the agent before running /catch-up.");
        await assertWorktreeIdle();
        await git(root, "reset", "--hard", commit);
        report(`Caught up to the main worktree at ${commit.slice(0, 12)}.`);
      } catch (error) {
        report(`Catch-up failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally { running = false; }
    },
  });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CATCH_UP_MESSAGE) }));
}

export default function sessionBroker(pi: ExtensionAPI) {
  registerTurnCapture(pi);
  registerCatchUp(pi);
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  registerForkAndForget(pi);
  pi.registerTool({
    name: "list_agents", label: "List agents", description: "List Pi agents addressable through piop", promptSnippet: "List agents by hostId and sessionId",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) { const data = await request("/agents", undefined, signal); return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data }; },
  });
  pi.registerTool({
    name: "send_message", label: "Send message", description: "Send a message to another Pi agent and wait for its reply", promptSnippet: "Message an agent by hostId and sessionId",
    parameters: Type.Object({ hostId: Type.String({ description: "Machine id, such as local" }), sessionId: Type.String({ description: "Pi session id" }), message: Type.String({ description: "Message for the target agent" }) }),
    async execute(_id, params, signal) {
      const requestId = crypto.randomUUID();
      const abort = () => { void cancelRequest(requestId); }; signal?.addEventListener("abort", abort, { once: true });
      try {
        const data = await request("/message", { ...params, requestId, deadline: Date.now() + MESSAGE_TIMEOUT_MS }, signal, MESSAGE_TIMEOUT_MS);
        return { content: [{ type: "text", text: String((data as { reply?: unknown })?.reply ?? "") }], details: data };
      } catch (error) { await cancelRequest(requestId); throw error; } finally { signal?.removeEventListener("abort", abort); }
    },
  });
}
