import { registerRequestUserInput } from "./ask-user.ts";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, realpath, stat, open, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

const MESSAGE_TIMEOUT_MS = 120_000;

type StoppedAssistantMessage = AssistantMessage & { piopCompletedBlocks?: true };

function replayableThinking(signatureText: string | undefined) {
  try {
    const signature = JSON.parse(signatureText ?? "null");
    return signature?.type === "reasoning" && typeof signature.encrypted_content === "string" && signature.encrypted_content.trim();
  } catch { return false; }
}

export function desktopPauseContext(messages: ContextEvent["messages"], resumeMessages: ReadonlySet<string>): ContextEvent["messages"] {
  return messages.filter((message) => !(message.role === "assistant" && message.stopReason === "aborted" && message.errorMessage === "Response paused")).map((message) => {
    if (message.role === "assistant" && message.stopReason === "aborted" && (message as StoppedAssistantMessage).piopCompletedBlocks && message.content.length) {
      const content = message.content.flatMap<AssistantMessage["content"][number]>((block) => {
        if (block.type !== "thinking" || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(message.api)) return [block];
        if (replayableThinking(block.thinkingSignature)) return [block];
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

function requestOptions(body: unknown, signal: AbortSignal) {
  return { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify({ ...(body as Record<string, unknown>), clientId: process.env.PIOP_CONVERSATION_CLIENT }) : undefined, signal };
}

async function request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000) {
  signal?.throwIfAborted();
  if (!url || !token) throw new Error("piop session broker is unavailable");
  const controller = new AbortController();
  const operationId = path.startsWith("/worktrees/") ? randomUUID() : undefined;
  if (operationId) body = { ...(body as Record<string, unknown>), requestId: operationId, deadline: Date.now() + timeoutMs };
  const timeout = setTimeout(() => controller.abort(new Error("Session broker request timed out")), timeoutMs);
  const cancelOperation = () => { if (operationId) void cancelRequest(operationId); };
  controller.signal.addEventListener("abort", cancelOperation, { once: true });
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${url}${path}`, requestOptions(body, controller.signal));
    const result = await response.json() as { error?: string; data?: unknown };
    if (!response.ok || result.error) throw new Error(result.error || `Session broker returned HTTP ${response.status}`);
    return result.data;
  } catch (error) { if (operationId) await cancelRequest(operationId); throw error; }
  finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancelOperation); signal?.removeEventListener("abort", abort); }
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
    pauseStopped = false;
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
    if ((isPausing || pauseStopped) && (event.message.stopReason === "aborted" || (event.message.stopReason === "error" && (ctx.signal?.aborted || event.message.errorMessage === "This operation was aborted")))) {
      if (isPausing && !pauseStopped) return { message: { ...event.message, stopReason: "aborted", errorMessage: "Response paused" } };
      const message: StoppedAssistantMessage = { ...event.message, stopReason: "aborted", errorMessage: undefined, content, piopCompletedBlocks: true };
      return { message };
    }
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
      pi.events.emit("piop:cancel-preparation", {});
      controlContext = ctx; pauseStopped = true;
      if (isPaused || isPausing) persistPause(false);
      publishPause(); ctx.abort(); await pauseOperation; await waitForIdle(ctx, generation);
    },
  };
  const unsubscribe = pi.events.on("pi-desktop:pause-controller", (value) => { (value as { controller?: PauseController }).controller = controller; });
  pi.on("session_shutdown", () => { generation += 1; unsubscribe(); pauseOperation = undefined; });
  const applyControl = async (action: string, ctx: ExtensionContext) => {
    if (action === "pause") await controller.pause(ctx);
    else if (action === "resume") return controller.resume(ctx);
    else if (action === "stop") await controller.stop(ctx);
    else if (action === "cancel-preparation") pi.events.emit("piop:cancel-preparation", {});
    else if (action !== "state") throw new Error(`Unknown desktop control: ${action}`);
  };
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
        resumeMessage = await applyControl(action, ctx);
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
  const loadConfig = async (path: string) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<FastConfig>;
      if (typeof value.enabled === "boolean" && Array.isArray(value.targets) && value.targets.every((target) => target && typeof target.provider === "string" && typeof target.model === "string")) config = value as FastConfig;
    } catch { /* A missing or unreadable setting must not appear as disabled. */ }
  };
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
        await loadConfig(path);
      }
      loaded = true;
    }
    publish(ctx);
  };
  // The package only draws its indicator in TUI mode. Desktop asks after
  // startup and after /fast finishes writing its scoped configuration.
  // Keep that snapshot for model changes: another session may share the file
  // while each extension instance retains its own in-memory toggle.
  pi.registerCommand("pi-desktop-fast-status", {
    description: "Read Fast Mode status for piop", handler: (args, ctx) => {
      const next = queue.then(() => refresh(ctx, args.trim() === "refresh"));
      queue = next.catch(() => undefined);
      return next;
    }
  });
  pi.on("session_start", () => { loaded = false; config = undefined; available = false; });
  pi.on("model_select", (event, ctx) => { if (ctx.mode === "rpc" && loaded) publish(ctx, event.model); });
}

function registerForkAndForget(pi: ExtensionAPI) {
  const statusKey = "pi-desktop-control-response";
  pi.registerCommand("pi-desktop-fork-after", {
    description: "Branch after a completed response",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args) as { id?: string; entryId?: string };
        id = request.id;
        if (!id || ctx.mode !== "rpc" || typeof request.entryId !== "string") throw new Error("Invalid branch request");
        const fork = await forkConversation(ctx, { entryId: request.entryId }, async () => { throw new Error("Unexpected worktree request"); });
        const result = await ctx.switchSession(fork.sessionPath);
        ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: true, data: { cancelled: result.cancelled } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus(statusKey, `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(String(error), "error");
      }
    },
  });
  const assertAssistantEntry = (ctx: ExtensionContext, entryId: string) => {
    const entry = ctx.sessionManager.getEntry(entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Assistant response not found in this conversation");
  };
  pi.registerCommand("pi-desktop-fork-and-forget", {
    description: "Continue this session from an earlier assistant response",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args) as { id?: string; entryId?: string };
        id = request.id;
        if (!id || ctx.mode !== "rpc" || typeof request.entryId !== "string") throw new Error("Invalid fork-and-forget request");
        assertAssistantEntry(ctx, request.entryId);
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
      const capture = JSON.parse(stdout);
      if (!capture || typeof capture.root !== "string" || !capture.root || typeof capture.repository_root !== "string" || !capture.repository_root
        || typeof capture.tree !== "string" || !/^[a-f0-9]{40,64}$/i.test(capture.tree)) throw new Error("Git snapshot was incomplete");
      return JSON.stringify({ root: capture.root, tree: capture.tree, repository_root: capture.repository_root });
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
  function assertMainWorktree(first: string[], main: string | undefined): asserts main is string {
    if (!main || first.includes("bare")) throw new Error("No main working tree is available for this repository.");
  }
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
        assertMainWorktree(first, main);
        if (await realpath(root) === await realpath(main)) { report("Already in the main worktree. Nothing changed."); return; }
        await assertWorktreeIdle();
        const commit = (await git(main, "rev-parse", "--verify", "HEAD^{commit}")).trim();
        const confirmed = await ctx.ui.confirm("Catch up this worktree?", `Reset ${root} to the main worktree (${main}) at commit ${commit.slice(0, 12)}? This discards tracked local changes and moves the current branch to that commit. Uncommitted changes in the main worktree will not be copied.`);
        if (!confirmed) return;
        if (!ctx.isIdle()) throw new Error("Stop or pause the agent before running /catch-up.");
        await assertWorktreeIdle();
        const untracked = (await git(root, "ls-files", "--others", "-z", "--")).split("\0").filter(Boolean);
        const targetPaths = (await git(root, "ls-tree", "-r", "--name-only", "-z", commit)).split("\0").filter(Boolean);
        const collision = untracked.find((file) => targetPaths.some((target) => file === target || file.startsWith(`${target}/`) || target.startsWith(`${file}/`)));
        if (collision) throw new Error(`Untracked path ${JSON.stringify(collision)} would be overwritten. Move or commit it before catching up.`);
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
  registerVoiceHistory(pi);
  registerCatchUp(pi);
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  registerForkAndForget(pi);
  registerSessionOperations(pi);
  registerSubagents(pi);
  registerRequestUserInput(pi);
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

function validSpokenTurn(turn: { id?: unknown; role?: unknown; text?: unknown; startMs?: unknown; endMs?: unknown } | undefined) {
  return turn && typeof turn.id === "string" && /^[a-f0-9-]{36}$/.test(turn.id) && ["user", "assistant"].includes(String(turn.role)) && typeof turn.text === "string" && turn.text.length <= 8000 && Number.isFinite(turn.startMs) && Number.isFinite(turn.endMs);
}

function registerVoiceHistory(pi: ExtensionAPI) {
  pi.registerCommand("pi-desktop-voice-history", {
    description: "Save a spoken conversation turn",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const request = JSON.parse(args); id = request.id;
        const turn = request.turn;
        if (!id || ctx.mode !== "rpc" || request.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Voice conversation changed");
        if (!validSpokenTurn(turn)) throw new Error("Invalid spoken turn");
        const voiceContext = turn.voiceContext;
        if (voiceContext !== undefined && (!voiceContext || !["systemPrompt", "workspace", "conversation", "feedback"].every(key => typeof voiceContext[key] === "string" && voiceContext[key].length <= 16000))) throw new Error("Invalid voice context");
        pi.appendEntry("piop-voice", { id: turn.id, role: turn.role, text: turn.text, startMs: turn.startMs, endMs: turn.endMs, completed: true, ...(voiceContext ? { voiceContext } : {}) });
        const manager = ctx.sessionManager as unknown as { isPersisted(): boolean; flushed: boolean; _rewriteFile(): void };
        if (manager.isPersisted() && !manager.flushed) { manager._rewriteFile(); manager.flushed = true; }
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, success: true, data: {} })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error) })}`);
      }
    },
  });
}

type ForkOptions = { cwd?: string; worktree?: string; entryId?: string };
type CreatedWorktree = { path: string; branch: string; setupError?: string | null };
const currentHost = () => process.env.PI_DESKTOP_HOST_ID || "local";

const SUBAGENT_RUN = "piop-subagent-run";
const SUBAGENT_PARENT = "piop-subagent-parent";

const SUBAGENT_TIMEOUT_MS = 600_000;
type SubagentTask = { task: string; name: string; agent?: string; sessionId?: string };
type SubagentRun = { version: 1; toolCallId: string; parentSessionId: string; sessionId: string; sessionPath: string; hostId: string; name: string; task: string; status: "running" | "completed" | "failed" | "cancelled"; startedAt: number; endedAt?: number; output?: string; apiCost?: number };

function completedSubagentOutput(last: AssistantMessage | undefined) {
  if (!last) throw new Error("Subagent produced no assistant response; inspect its transcript");
  if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `Subagent ${last.stopReason}`);
  if (last.stopReason === "toolUse") throw new Error("Subagent stopped before completing its task");
  const output = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "(No text returned; inspect the saved transcript.)";
  return output.length > 16_000 ? `${output.slice(0, 16_000)}\n[Result truncated. Full conversation is saved in the child transcript.]` : output;
}

async function subagentCompletion(run: SubagentRun, offset: number) {
  let last: AssistantMessage | undefined;
  let cost = 0;
  const input = createReadStream(run.sessionPath, { start: offset });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      last = entry.message as AssistantMessage;
      const amount = last.usage?.cost?.total;
      if (Number.isFinite(amount) && amount >= 0) cost += amount;
    }
  } finally { lines.close(); input.destroy(); }
  run.apiCost = cost;
  run.output = completedSubagentOutput(last);
  run.status = "completed";
}

async function createSubagent(pi: ExtensionAPI, ctx: ExtensionContext, task: SubagentTask, toolCallId: string): Promise<SubagentRun> {
  const parentSessionId = ctx.sessionManager.getSessionId();
  const runs = ctx.sessionManager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RUN ? [entry.data as SubagentRun] : []);
  if (task.sessionId) {
    if (task.agent) throw new Error("A resumed subagent keeps its original agent profile");
    const previous = runs.find((run) => run.parentSessionId === parentSessionId && run.sessionId === task.sessionId && run.hostId === currentHost() && run.sessionPath);
    if (!previous) throw new Error("Only a child created by this conversation can be resumed");
    return { ...previous, toolCallId, name: task.name, task: task.task, status: "running", startedAt: Date.now(), endedAt: undefined, output: undefined, apiCost: undefined };
  }
  const header = ctx.sessionManager.getHeader();
  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before delegating work");
  const profile: { agent?: string; state?: unknown; error?: string } = { agent: task.agent };
  pi.events.emit("piop:agents:subagent", profile);
  if (profile.error) throw new Error(profile.error);
  if (!profile.state) throw new Error("Agent profiles are unavailable");
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId, sessionId, sessionPath, hostId: currentHost(), name: task.name, task: task.task, status: "running", startedAt: Date.now() };
  let parentId: string | null = null;
  const entry = (value: object) => { const id = randomUUID().slice(0, 8); const result = { ...value, id, parentId, timestamp }; parentId = id; return result; };
  await writeFork(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    entry({ type: "session_info", name: `Subagent: ${task.name}` }),
    entry({ type: "custom", customType: SUBAGENT_PARENT, data: { version: 1, parentSessionId, parentSessionPath: ctx.sessionManager.getSessionFile(), toolCallId, task: task.task } }),
    entry({ type: "custom", customType: "pi-define-agents-state", data: profile.state }),
  ]);
  return run;
}

type SubagentExecution = { pi: ExtensionAPI; ctx: ExtensionContext; toolCallId: string; active: Set<string>; results: SubagentRun[]; signal?: AbortSignal; publish: () => void };

async function dispatchSubagent(run: SubagentRun, requestId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const offset = (await stat(run.sessionPath)).size;
  const abort = () => { void cancelRequest(requestId); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await request("/message", { hostId: run.hostId, sessionId: run.sessionId, message: run.task, requestId, deadline: Date.now() + SUBAGENT_TIMEOUT_MS }, signal, SUBAGENT_TIMEOUT_MS);
    await subagentCompletion(run, offset);
  } catch (error) { await cancelRequest(requestId); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
}

async function executeSubagent(task: SubagentTask, execution: SubagentExecution) {
  const { pi, ctx, toolCallId, active, results, signal, publish } = execution;
  const run: SubagentRun = { version: 1, toolCallId, parentSessionId: ctx.sessionManager.getSessionId(), sessionId: task.sessionId ?? "", sessionPath: "", hostId: currentHost(), name: task.name, task: task.task, status: "running", startedAt: Date.now() };
  results.push(run);
  let claimed = false;
  try {
    signal?.throwIfAborted();
    const child = await createSubagent(pi, ctx, task, toolCallId);
    if (active.has(child.sessionId)) throw new Error("This subagent is already running");
    Object.assign(run, child);
    active.add(run.sessionId); claimed = true;
    pi.appendEntry(SUBAGENT_RUN, { ...run }); publish();
    await dispatchSubagent(run, randomUUID(), signal);
  } catch (error) {
    run.status = signal?.aborted ? "cancelled" : "failed";
    run.output = error instanceof Error ? error.message : String(error);
  }
  if (claimed) active.delete(run.sessionId);
  run.endedAt = Date.now();
  pi.appendEntry(SUBAGENT_RUN, { ...run }); publish();
}

export function registerSubagents(pi: ExtensionAPI) {
  const active = new Set<string>();
  pi.registerTool({
    name: "subagent", label: "Subagents",
    description: "Delegate 1–4 independent tasks in parallel and wait for their results. Each child has a fresh context, a saved transcript visible in piop, and the current working directory (files are shared). Supply all necessary context in task. Defaults to the current agent profile and model; agent selects a named piop profile. Resume a previous child with its returned sessionId. Child agents cannot delegate further. Avoid overlapping edits. Runs are cancelled when this tool is stopped and time out after ten minutes.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), task: Type.String({ minLength: 1, maxLength: 100_000 }), agent: Type.Optional(Type.String({ minLength: 1 })), sessionId: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1, maxItems: 4 }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_PARENT)) throw new Error("Subagents cannot delegate further; return your findings to the parent");
      if (!params.tasks.length || params.tasks.length > 4 || params.tasks.some((task) => !task.task.trim() || !task.name.trim())) throw new Error("Provide 1–4 named, nonempty tasks");
      const resumed = params.tasks.flatMap((task) => task.sessionId ? [task.sessionId] : []);
      if (new Set(resumed).size !== resumed.length) throw new Error("A child can only receive one task at a time");
      const results: SubagentRun[] = [];
      const payload = () => ({ content: [{ type: "text" as const, text: results.map((run) => `${run.name}: ${run.status}\nSession: ${run.hostId}/${run.sessionId}\nTranscript: ${run.sessionPath}${run.output ? `\n${run.output}` : ""}`).join("\n\n") }], details: { version: 1, runs: structuredClone(results) } });
      await Promise.all(params.tasks.map((task) => executeSubagent(task, { pi, ctx, toolCallId, active, results, signal, publish: () => onUpdate?.(payload()) })));
      return { ...payload(), isError: results.some((run) => run.status !== "completed") };
    },
  });
}

// Both slash commands and model tools use these operations. Forking never changes
// the running agent's session, and never copies an unfinished tool-call turn.
export async function forkConversation(ctx: ExtensionContext, options: ForkOptions, createWorktree: (name: string) => Promise<CreatedWorktree>) {
  const retained = forkHistory(ctx, options.entryId);
  const header = ctx.sessionManager.getHeader();
  if (!header || !ctx.sessionManager.getSessionFile()) throw new Error("Save this conversation before forking it");
  let cwd = await forkDirectory(ctx.cwd, options);
  const worktree = options.worktree ? await createWorktree(options.worktree) : undefined;
  if (worktree) cwd = worktree.path;
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  try {
    await writeFork(sessionPath, [{ ...header, id: sessionId, timestamp, cwd, parentSession: ctx.sessionManager.getSessionFile() }, ...retained]);
  } catch (error) {
    if (worktree) throw new Error(`Worktree kept at ${cwd}, but conversation fork failed: ${String(error)}`);
    throw error;
  }
  return { hostId: currentHost(), sessionId, sessionPath, cwd, ...worktree };
}

async function forkDirectory(cwd: string, options: ForkOptions) {
  if (options.cwd && options.worktree) throw new Error("Choose cwd or worktree, not both");
  const path = await realpath(resolve(cwd, options.cwd ?? "."));
  if (!(await stat(path)).isDirectory()) throw new Error("Fork destination must be an existing directory");
  return path;
}

function forkHistory(ctx: ExtensionContext, entryId?: string) {
  const branch = ctx.sessionManager.getBranch();
  const complete = (entry: typeof branch[number]) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "toolUse" && !entry.message.content.some((part) => part.type === "toolCall")
    || entry.type === "custom" && entry.customType === "piop-voice" && (entry.data as { role?: string; completed?: boolean })?.role === "assistant" && (entry.data as { completed?: boolean }).completed === true;
  const entry = entryId ? branch.find((entry) => entry.id === entryId) : [...branch].reverse().find(complete);
  if (entryId && (!entry || !complete(entry))) throw new Error("entryId must identify a completed assistant response on the current branch");
  if (!entry) return [];
  const retained = branch.slice(0, branch.indexOf(entry) + 1);
  const ids = new Set(retained.map((item) => item.id));
  const checkpoint = branch.slice(branch.indexOf(entry) + 1).find((item) => item.type === "custom" && item.customType === "pi-project-files-watch-snapshot"
    && (item.data as { responseEntryIds?: string[] })?.responseEntryIds?.includes(entry.id));
  if (checkpoint?.type === "custom") {
    const data = checkpoint.data as { responseEntryIds: string[] };
    retained.push({ ...checkpoint, parentId: entry.id, data: { ...data, responseEntryIds: data.responseEntryIds.filter((id) => ids.has(id)) } });
  }
  return retained;
}

async function writeFork(path: string, entries: unknown[]) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); }
  catch (error) { await rm(path, { force: true }); throw error; }
  finally { await file.close(); }
}

export function registerSessionOperations(pi: ExtensionAPI) {
  const create = (ctx: ExtensionContext, name: string, signal?: AbortSignal) => request("/worktrees/create", { hostId: currentHost(), cwd: ctx.cwd, name }, signal, MESSAGE_TIMEOUT_MS) as Promise<CreatedWorktree>;
  const fork = (ctx: ExtensionContext, options: ForkOptions, signal?: AbortSignal) => { signal?.throwIfAborted(); return forkConversation(ctx, options, (name) => create(ctx, name, signal)); };
  const remove = (cwd: string, deleteBranch = false, signal?: AbortSignal) => request("/worktrees/remove", { hostId: currentHost(), cwd, deleteBranch }, signal, MESSAGE_TIMEOUT_MS);
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data });
  pi.registerTool({
    name: "fork_session", label: "Fork conversation",
    description: "Create a separate saved conversation through a completed assistant response. Works with or without Git. Defaults to the latest completed response (empty history if none). Keeps the current agent running. Optionally use another existing directory or create a Git worktree with current files. Returns hostId/sessionId for send_message; does not start the child.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String({ description: "Existing destination directory; defaults to current directory. Files are not copied." })), worktree: Type.Optional(Type.String({ description: "New Git worktree name; mutually exclusive with cwd" })), entryId: Type.Optional(Type.String({ description: "Completed assistant entry on the current branch" })) }),
    async execute(_id, params, signal, _update, ctx) { return result(await fork(ctx, params, signal)); },
  });
  pi.registerTool({
    name: "create_worktree", label: "Create Git worktree", description: "Create a Git branch and worktree from current files, including uncommitted and nonignored untracked files, then run configured setup scripts. Does not create a conversation. Requires a Git project. Setup failures return the kept path and setupError.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal, _update, ctx) { return result(await create(ctx, params.name, signal)); },
  });
  pi.registerTool({
    name: "remove_worktree", label: "Remove Git worktree", description: "Remove an unused clean Git worktree after configured cleanup scripts. Refuses the main checkout, dirty worktrees, and worktrees used by conversations or terminals. Branch deletion is optional and never forced.",
    parameters: Type.Object({ cwd: Type.String(), deleteBranch: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) { return result(await remove(resolve(ctx.cwd, params.cwd), params.deleteBranch, signal)); },
  });
  const report = async (ctx: ExtensionContext, operation: () => Promise<unknown>) => {
    try { pi.sendMessage({ customType: "piop-session-operation", content: JSON.stringify(await operation(), null, 2), display: true }, { triggerTurn: false }); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  pi.registerCommand("fork-session", {
    description: 'Fork conversation: /fork-session [directory] or /fork-session --worktree name', handler: async (args, ctx) => report(ctx, () => {
      const value = args.trim();
      if (value === "--worktree") throw new Error("Usage: /fork-session --worktree name");
      return fork(ctx, value.startsWith("--worktree ") ? { worktree: value.slice(11).trim() } : { cwd: value || undefined });
    })
  });
  pi.registerCommand("create-worktree", { description: "Create worktree with current files: /create-worktree name", handler: async (args, ctx) => report(ctx, () => create(ctx, args.trim())) });
  pi.registerCommand("remove-worktree", {
    description: "Remove unused clean worktree, keeping its branch: /remove-worktree path", handler: async (args, ctx) => report(ctx, () => {
      if (!args.trim()) throw new Error("Usage: /remove-worktree path");
      return remove(resolve(ctx.cwd, args.trim()));
    })
  });
}
