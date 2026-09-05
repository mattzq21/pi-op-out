import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

const MESSAGE_TIMEOUT_MS = 120_000;

export function desktopPauseContext(messages: ContextEvent["messages"], resumeMessages: ReadonlySet<string>): ContextEvent["messages"] {
  return messages.filter((message) => !(message.role === "assistant" && message.stopReason === "aborted" && message.errorMessage === "Response paused")).map((message) => {
    if (message.role !== "user") return message;
    const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return resumeMessages.has(text) ? { ...message, content: [{ type: "text" as const, text: "Continue the previous task using the completed turns and tool results already in context. The last run was paused by the user. Check the current state of any interrupted work before continuing, and finish the remaining task without repeating completed work." }] } : message;
  });
}

async function cancelRequest(requestId: string) {
  if (!url || !token) return;
  await fetch(`${url}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => undefined);
}

async function request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000) {
  if (!url || !token) throw new Error("Pi Desktop session broker is unavailable");
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
  let generation = 0;
  const publishPause = () => {
    controlContext?.ui.setStatus(pauseEntry, `json:${JSON.stringify({ type: "pause_state", isPaused, isPausing })}`);
  };
  const persistPause = (paused: boolean) => { isPaused = paused; pi.appendEntry(pauseEntry, { isPaused: paused }); };
  const restorePause = (ctx: ExtensionContext) => {
    generation += 1; controlContext = ctx;
    isPaused = false; isPausing = false; pauseStopped = false; resumeMessages.clear();
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
  pi.on("message_end", (event, ctx) => {
    if (isPausing && event.message.role === "assistant" && (event.message.stopReason === "aborted" || (event.message.stopReason === "error" && ctx.signal?.aborted))) return { message: { ...event.message, stopReason: "aborted", errorMessage: "Response paused" } };
  });
  pi.on("context", (event) => ({ messages: desktopPauseContext(event.messages, resumeMessages) }));
  const waitForIdle = async (ctx: ExtensionContext, version: number) => {
    while (version === generation && !ctx.isIdle()) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const controller: PauseController = {
    state: () => ({ isPaused, isPausing }),
    pause(ctx) {
      controlContext = ctx;
      if (!pauseOperation && !isPaused && !ctx.isIdle()) {
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
    description: "Control Pi Desktop pause and resume",
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
    const text = !available ? undefined : !config ? "Fast mode status unavailable" : !config.enabled ? "Fast mode off" : supported ? "Fast mode on" : "Fast mode on · unavailable for this model";
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
  pi.registerCommand("pi-desktop-fast-status", { description: "Read Fast Mode status for Pi Desktop", handler: (args, ctx) => {
    const next = queue.then(() => refresh(ctx, args.trim() === "refresh"));
    queue = next.catch(() => undefined);
    return next;
  } });
  pi.on("session_start", () => { loaded = false; config = undefined; available = false; });
  pi.on("model_select", (event, ctx) => { if (ctx.mode === "rpc" && loaded) publish(ctx, event.model); });
}

export default function sessionBroker(pi: ExtensionAPI) {
  registerPauseControl(pi);
  registerFastModeStatus(pi);
  pi.registerTool({
    name: "list_agents", label: "List agents", description: "List Pi agents addressable through Pi Desktop", promptSnippet: "List agents by hostId and sessionId",
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
        const data = await request("/message", { ...params, requestId }, signal, MESSAGE_TIMEOUT_MS);
        return { content: [{ type: "text", text: String((data as { reply?: unknown })?.reply ?? "") }], details: data };
      } finally { signal?.removeEventListener("abort", abort); }
    },
  });
}
