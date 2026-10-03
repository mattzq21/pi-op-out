import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type StoppedAssistantMessage = AssistantMessage & { piopCompletedBlocks?: true };

const reasoningSchema = Type.Object({ type: Type.Literal("reasoning"), encrypted_content: Type.String() });

const completedBlocksSchema = Type.Object({ piopCompletedBlocks: Type.Literal(true) });

const pauseSchema = Type.Object({ isPaused: Type.Literal(true) });

const resumeSchema = Type.Object({ message: Type.String() });

const controlSchema = Type.Object({ id: Type.Optional(Type.String()), action: Type.Optional(Type.String()) });

interface PauseProbe { controller?: PauseController }

interface GoalResumeRequest { action: "resume"; ctx: ExtensionContext; ready?: Promise<void> }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "pi-desktop:pause-controller", handler: (probe: PauseProbe) => void): () => void;
    emit(channel: "pi-desktop:pause-controller", probe: PauseProbe): void;
  }
}

function replayableThinking(signatureText: string | undefined) {
  try {
    const signature = JSON.parse(signatureText ?? "null");

    return Check(reasoningSchema, signature) && signature.encrypted_content.trim();
  } catch { return false; }
}

export function desktopPauseContext(messages: ContextEvent["messages"], resumeMessages: ReadonlySet<string>): ContextEvent["messages"] {
  return messages.filter((message) => !(message.role === "assistant" && message.stopReason === "aborted" && message.errorMessage === "Response paused")).map((message): ContextEvent["messages"][number] => {
    if (message.role === "assistant" && message.stopReason === "aborted" && Check(completedBlocksSchema, message) && message.content.length) {
      const content = message.content.flatMap<AssistantMessage["content"][number]>((block) => {
        if (block.type !== "thinking" || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(message.api)) return [block];

        if (replayableThinking(block.thinkingSignature)) return [block];

        return !block.redacted && block.thinking.trim() ? [{ type: "text", text: block.thinking }] : [];
      });

      if (!content.length) return message;

      return {
        ...message,
        stopReason: "stop",
        errorMessage: undefined,
        content: [...content, { type: "text", text: "[Response stopped by the user. Only completed content blocks are retained. Any tool calls in this response were not executed.]" }],
      };
    }

    if (message.role !== "user") return message;
    const text = Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : message.content;

    return resumeMessages.has(text) ? { ...message, content: [{ type: "text", text: "Continue the previous task using the completed turns and tool results already in context. The last run was paused by the user. Check the current state of any interrupted work before continuing, and finish the remaining task without repeating completed work." }] } : message;
  });
}

export interface PauseController {
  state(): { isPaused: boolean; isPausing: boolean };
  pause(ctx: ExtensionContext): Promise<void>;
  resume(ctx: ExtensionContext): Promise<string | undefined>;
  stop(ctx: ExtensionContext): Promise<void>;
}

function wasAborted(message: AssistantMessage, ctx: ExtensionContext) {
  return message.stopReason === "aborted" || (message.stopReason === "error" && (ctx.signal?.aborted || message.errorMessage === "This operation was aborted"));
}

export function registerPauseControl(pi: ExtensionAPI): PauseController {
  const probe: PauseProbe = {};
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

      if (entry.customType === pauseEntry) isPaused = Check(pauseSchema, entry.data);

      if (entry.customType === resumeEntry && Check(resumeSchema, entry.data)) resumeMessages.add(entry.data.message);
    }

    publishPause();
  };

  pi.on("session_start", (_event, ctx) => { restorePause(ctx); });
  pi.on("session_tree", (_event, ctx) => { restorePause(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    if (isPausing) { ctx.abort();

    return; }

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

    if ((isPausing || pauseStopped) && wasAborted(event.message, ctx)) {
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
      pi.events.emit("piop:goal-control", { action: "pause", ctx });

      if (!pauseOperation && !isPaused) {
        const version = generation;
        pauseStopped = false; isPausing = true; persistPause(true); isPaused = false; publishPause();
        pauseOperation = (async () => {
          try { pi.events.emit("piop:cancel-preparation", {}); ctx.abort(); await waitForIdle(ctx, version); }
          finally { if (version === generation) { isPaused = !pauseStopped; isPausing = false; pauseOperation = undefined; publishPause(); } }
        })();
      }

      return pauseOperation ?? Promise.resolve();
    },
    async resume(ctx) {
      controlContext = ctx;

      if (isPausing || !ctx.isIdle()) throw new Error("Wait for Pi to finish pausing before resuming");

      if (!isPaused) return undefined;
      const version = generation;
      const goalControl: GoalResumeRequest = { action: "resume", ctx };
      pi.events.emit("piop:goal-control", goalControl);
      await goalControl.ready;

      if (version !== generation || !isPaused || !ctx.isIdle()) return;
      const message = `/pi-desktop-resume-turn ${crypto.randomUUID()}`;
      resumeMessages.add(message); pi.appendEntry(resumeEntry, { message });

      return message;
    },
    async stop(ctx) {
      pi.events.emit("piop:goal-control", { action: "pause", ctx });
      pi.events.emit("piop:cancel-preparation", {});
      controlContext = ctx; pauseStopped = true;

      if (isPaused || isPausing) persistPause(false);
      publishPause(); ctx.abort(); await pauseOperation; await waitForIdle(ctx, generation);
    },
  };

  const unsubscribe = pi.events.on("pi-desktop:pause-controller", (value) => { value.controller = controller; });
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
        const control = Parse(controlSchema, JSON.parse(args)); id = control.id; action = control.action ?? "";

        if (!id || ctx.mode !== "rpc") throw new Error("Desktop control requires an RPC request");
        resumeMessage = await applyControl(action, ctx);
        const data = resumeMessage ? { isPaused, isPausing, resumeMessage } : { isPaused, isPausing };
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: true, data })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, command: action, success: false, error: error instanceof Error ? error.message : String(error) })}`);
        else ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  return controller;
}
