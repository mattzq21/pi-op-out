import { extendedHooks } from "../hooks-extended/interface.ts";
import { sessionStorage } from "../piop-storage/interface.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalSession } from "../piop-goals/interface.ts";
import type { PauseState } from "./interface.ts";

type StoppedAssistantMessage = AssistantMessage & { piopCompletedBlocks?: true };

const reasoningSchema = Type.Object({ type: Type.Literal("reasoning"), encrypted_content: Type.String() });

const completedBlocksSchema = Type.Object({ piopCompletedBlocks: Type.Literal(true) });

const pauseSchema = Type.Object({ isPaused: Type.Literal(true) });

const resumeSchema = Type.Object({ message: Type.String() });

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
  state(): PauseState;
  pause(ctx: ExtensionContext): Promise<void>;
  resume(ctx: ExtensionContext): Promise<string | undefined>;
  stop(ctx: ExtensionContext): Promise<void>;
  cancelPreparation(): void;
}

function wasAborted(message: AssistantMessage) {
  return message.stopReason === "aborted" || (message.stopReason === "error" && message.errorMessage === "This operation was aborted");
}

/** Pauses an active goal. Goal failures are reported and do not stop the session pause. */
function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext) {
  void goalSession(pi)?.pauseWithSession(ctx).catch(error => ctx.ui.notify((error instanceof Error ? error.message : String(error)), "error"));
}

/**
 * Pause, resume and stop for the current session run. Restores the pause from the session history and keeps
 * completed content of stopped responses. Calls publish with the session context after each pause state change.
 */
export function registerPauseControl(pi: ExtensionAPI, publish: (ctx: ExtensionContext, state: PauseState) => void): PauseController {
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
    if (controlContext) publish(controlContext, { isPaused, isPausing });
  };

  const persistPause = (paused: boolean) => { sessionStorage(pi).append(pauseEntry, { isPaused: paused }); isPaused = paused; };

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

  extendedHooks(pi).on("session_restore", (_event, ctx) => { restorePause(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    if (isPausing) { ctx.abort();

    return; }

    pauseStopped = false;

    if (isPaused) { persistPause(false); publishPause(); }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") completedBlocks.clear();
  });
  pi.on("message_update", (event, ctx) => {
    const update = event.assistantMessageEvent;

    if (update.type !== "text_end" && update.type !== "thinking_end" && update.type !== "toolcall_end") return;

    // Some providers end every open block when the response is stopped. A tool call ended that way is cut off.
    if (update.type === "toolcall_end" && ctx.signal?.aborted) return;
    const block = update.partial.content[update.contentIndex];

    if (block) completedBlocks.set(update.contentIndex, structuredClone(block));
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const content = [...completedBlocks].sort(([left], [right]) => left - right).map(([, block]) => block);
    completedBlocks.clear();

    if ((isPausing || pauseStopped) && wasAborted(event.message)) {
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

  const waitForIdle = (ctx: ExtensionContext) => extendedHooks(pi).waitForAvailable(ctx);

  const controller: PauseController = {
    state: () => ({ isPaused, isPausing }),
    pause(ctx) {
      controlContext = ctx;
      pauseGoal(pi, ctx);

      if (!pauseOperation && !isPaused) {
        const version = generation;
        pauseStopped = false; isPausing = true; persistPause(true); isPaused = false; publishPause();
        pauseOperation = (async () => {
          try { controller.cancelPreparation(); ctx.abort(); await waitForIdle(ctx); }
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
      await goalSession(pi)?.resumeWithSession(ctx);

      if (version !== generation || !isPaused || !ctx.isIdle()) return;
      const message = `/pi-desktop-resume-turn ${crypto.randomUUID()}`;
      resumeMessages.add(message); sessionStorage(pi).append(resumeEntry, { message });

      return message;
    },
    async stop(ctx) {
      pauseGoal(pi, ctx);
      controller.cancelPreparation();
      controlContext = ctx; pauseStopped = true;

      if (isPaused || isPausing) persistPause(false);
      publishPause(); ctx.abort(); await pauseOperation; await waitForIdle(ctx);
    },
    cancelPreparation() { pi.events.emit("piop:cancel-preparation", {}); },
  };

  pi.on("session_shutdown", () => { generation += 1; pauseOperation = undefined; });

  return controller;
}
