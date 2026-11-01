import { extendedHooks } from "../hooks-extended/interface.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type StoppedAssistantMessage = AssistantMessage & { piopCompletedBlocks?: true };

const reasoningSchema = Type.Object({ type: Type.Literal("reasoning"), encrypted_content: Type.String() });

const completedBlocksSchema = Type.Object({ piopCompletedBlocks: Type.Literal(true) });

function replayableThinking(signatureText: string | undefined) {
  try {
    const signature = JSON.parse(signatureText ?? "null");

    return Check(reasoningSchema, signature) && signature.encrypted_content.trim();
  } catch { return false; }
}

export function stoppedResponsesContext(messages: ContextEvent["messages"]): ContextEvent["messages"] {
  return messages.map((message): ContextEvent["messages"][number] => {
    if (message.role !== "assistant" || message.stopReason !== "aborted" || !Check(completedBlocksSchema, message) || !message.content.length) return message;
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
  });
}

export interface StopController {
  stop(ctx: ExtensionContext): Promise<void>;
  cancelPreparation(): void;
}

function wasAborted(message: AssistantMessage) {
  return message.stopReason === "aborted" || (message.stopReason === "error" && message.errorMessage === "This operation was aborted");
}

export function registerStopControl(pi: ExtensionAPI): StopController {
  let stopping = false;
  const completedBlocks = new Map<number, AssistantMessage["content"][number]>();

  extendedHooks(pi).on("session_restore", () => { stopping = false; completedBlocks.clear(); });
  pi.on("agent_start", () => { stopping = false; });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") completedBlocks.clear();
  });
  pi.on("message_update", (event, ctx) => {
    const update = event.assistantMessageEvent;

    if (update.type !== "text_end" && update.type !== "thinking_end" && update.type !== "toolcall_end") return;

    if (update.type === "toolcall_end" && ctx.signal?.aborted) return;
    const block = update.partial.content[update.contentIndex];

    if (block) completedBlocks.set(update.contentIndex, structuredClone(block));
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const content = [...completedBlocks].sort(([left], [right]) => left - right).map(([, block]) => block);
    completedBlocks.clear();

    if (event.message.stopReason !== "aborted" && !(stopping && wasAborted(event.message))) return;
    const message: StoppedAssistantMessage = { ...event.message, stopReason: "aborted", errorMessage: undefined, content, piopCompletedBlocks: true };

    return { message };
  });
  pi.on("context", (event) => ({ messages: stoppedResponsesContext(event.messages) }));

  const controller: StopController = {
    async stop(ctx) {
      controller.cancelPreparation();
      stopping = true;
      ctx.abort();
      await extendedHooks(pi).waitForAvailable(ctx);
    },
    cancelPreparation() { pi.events.emit("piop:cancel-preparation", {}); },
  };

  return controller;
}
