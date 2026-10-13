import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ANSWER_QUESTION_COMMAND, PENDING_QUESTIONS_STATUS_KEY, QUESTION_ENTRY, QUESTION_RECOVERY_STATUS_KEY } from "./interface.ts";
import { answerRequest, newRequest, pendingRequests, recoverableAnswers, type Entry } from "./questions.ts";

/** Log entry type the session broker saves in subagent conversations. */
const SUBAGENT_PARENT_ENTRY = "piop-subagent-parent";

type AppRequest = { command: string; payload?: unknown; ctx: ExtensionContext; ready?: Promise<unknown> };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:rpc", handler: (request: AppRequest) => void): () => void;
  }
}

const commandSchema = Type.Object({ requestId: Type.String(), action: Type.Union([Type.Literal("prepare"), Type.Literal("resolve")]), value: Type.Optional(Type.String()), cancelled: Type.Optional(Type.Boolean()), queueId: Type.Optional(Type.String()) });

const parameters = Type.Object({ questions: Type.Array(Type.Object({
  title: Type.String({ description: "The complete question shown to the user, including any context needed to answer it." }),
  options: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Suggested answers, in display order. Put the recommended answer first; the first option is preselected by default. The user can select one option or enter a free-text answer. Do not include an Other option or a free-text placeholder; the UI provides free-text input automatically. Omit options for a free-text-only question." })),
}, { additionalProperties: false }), { minItems: 1, description: "One or more self-contained questions to present together, in display order." }) }, { additionalProperties: false });

function branch(ctx: ExtensionContext): Entry[] {
  return ctx.sessionManager.getBranch();
}

function publish(ctx: ExtensionContext) {
  ctx.ui.setStatus(PENDING_QUESTIONS_STATUS_KEY, JSON.stringify(pendingRequests(branch(ctx))));
  ctx.ui.setStatus(QUESTION_RECOVERY_STATUS_KEY, JSON.stringify(recoverableAnswers(branch(ctx))));
}

export default function userQuestions(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("session_tree", (_event, ctx) => publish(ctx));
  pi.registerTool({
    name: "request_user_input", label: "Ask user",
    exposure: "model-only",
    description: "Ask the user one or more questions during ongoing work. Use only for missing information, preferences, constraints, clarification, or approval. Returns immediately without ending the turn or waiting for a reply; replies arrive later as user follow-up messages. Continue independent work while waiting. Questions remain available if the user does not answer. A preselected option is not submitted automatically. Never interpret silence as an answer or approval.",
    parameters,
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();

      if (branch(ctx).some(entry => entry.type === "custom" && "customType" in entry && entry.customType === SUBAGENT_PARENT_ENTRY)) throw new Error("Only the root conversation can ask the user");

      if (ctx.mode !== "rpc") throw new Error("Questions require the piop interface");
      pi.appendEntry(QUESTION_ENTRY, newRequest(toolCallId, params.questions));
      publish(ctx);

      return { content: [{ type: "text", text: '{"accepted":true}' }], details: { accepted: true } };
    },
  });
  pi.events.on("piop:rpc", request => {
    if (request.command !== ANSWER_QUESTION_COMMAND) return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const { record, result } = answerRequest(branch(ctx), Parse(commandSchema, request.payload));

      if (record) {
        pi.appendEntry(QUESTION_ENTRY, record);
        publish(ctx);
      }

      return result;
    })();
  });
}
