import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_DESKTOP_BROKER_URL;
const token = process.env.PI_DESKTOP_BROKER_TOKEN;

const MESSAGE_TIMEOUT_MS = 120_000;

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

export default function sessionBroker(pi: ExtensionAPI) {
  const pauseEntry = "pi-desktop-pause-state";
  const resumeEntry = "pi-desktop-resume";
  let isPaused = false;
  let isPausing = false;
  let pauseStopped = false;
  let pauseOperation: Promise<void> | undefined;
  let controlContext: ExtensionContext | undefined;
  const resumeMessages = new Set<string>();
  const publishPause = () => {
    controlContext?.ui.setStatus(pauseEntry, `json:${JSON.stringify({ type: "pause_state", isPaused, isPausing })}`);
  };
  const persistPause = (paused: boolean) => { isPaused = paused; pi.appendEntry(pauseEntry, { isPaused: paused }); };
  const restorePause = (ctx: ExtensionContext) => {
    controlContext = ctx;
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
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => !(message.role === "assistant" && message.stopReason === "aborted" && message.errorMessage === "Response paused")).map((message) => {
    if (message.role !== "user") return message;
    const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return resumeMessages.has(text) ? { ...message, content: [{ type: "text" as const, text: "Continue the previous task using the completed turns and tool results already in context. The last run was paused by the user. Check the current state of any interrupted work before continuing, and finish the remaining task without repeating completed work." }] } : message;
  }) }));
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
        if (action === "pause") {
          if (!pauseOperation && !ctx.isIdle()) {
            pauseStopped = false; isPausing = true; persistPause(true); isPaused = false; publishPause();
            pauseOperation = (async () => { try { ctx.abort(); await ctx.waitForIdle(); } finally { isPaused = !pauseStopped; isPausing = false; pauseOperation = undefined; publishPause(); } })();
          }
          await pauseOperation;
        } else if (action === "resume") {
          if (isPausing || !ctx.isIdle()) throw new Error("Wait for Pi to finish pausing before resuming");
          if (isPaused) {
            const message = `/pi-desktop-resume-turn ${crypto.randomUUID()}`;
            resumeMessages.add(message); pi.appendEntry(resumeEntry, { message });
            // The native bridge submits this through normal RPC prompt preflight.
            // Keep Resume available until a successful prompt starts the agent.
            resumeMessage = message;
          }
        } else if (action === "stop") {
          pauseStopped = true;
          if (isPaused || isPausing) persistPause(false);
          publishPause(); ctx.abort();
          // Keep aborting queued runs until the pending pause has fully settled.
          await pauseOperation;
          await ctx.waitForIdle();
        } else if (action !== "state") throw new Error(`Unknown desktop control: ${action}`);
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: true, data: { isPaused, isPausing, ...(resumeMessage ? { resumeMessage } : {}) } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
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
