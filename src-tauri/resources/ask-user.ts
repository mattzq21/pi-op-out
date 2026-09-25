import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "piop-async-question";
const STATUS = "piop-async-questions";
type Question = { title: string; options?: string[] };
type Request = { id: string; questions: Question[]; resolved?: boolean; answers?: Record<string, { answers: string[] }> };
type ResponseCommand = { id: string; requestId: string; action: "prepare" | "resolve"; value?: string; cancelled?: boolean };

function requests(ctx: ExtensionContext) {
  const items = new Map<string, Request>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const item = entry.data as Request;
    items.set(item.id, item);
  }
  return items;
}

function publish(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS, JSON.stringify([...requests(ctx).values()].filter((item) => !item.resolved)));
}

function validateQuestions(questions: Question[]) {
  if (!questions.length) throw new Error("questions must not be empty");
  for (const question of questions) {
    if (!question.title.trim()) throw new Error("question titles must not be empty");
    if (question.options && (!question.options.length || question.options.some((option) => !option.trim()))) throw new Error("options must contain at least one non-empty answer");
  }
}

function answerRequest(item: Request, command: ResponseCommand) {
  if (command.cancelled) return { answers: {}, message: undefined };
  const response = JSON.parse(command.value ?? "{}") as { answers?: Record<string, { answers?: unknown }> };
  const answers = Object.fromEntries(item.questions.map((_question, index) => {
    const values = response.answers?.[`question_${index}`]?.answers;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) throw new Error("Invalid question answer");
    return [`question_${index}`, { answers: values as string[] }];
  }));
  const answered = item.questions.flatMap((question, index) => {
    const values = answers[`question_${index}`].answers.filter((value) => value.trim());
    return values.length ? [`${question.title}\n${values.join("\n")}`] : [];
  });
  return { answers, message: answered.length ? `In response to your questions:\n\n${answered.join("\n\n")}` : undefined };
}

export function registerRequestUserInput(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("session_tree", (_event, ctx) => publish(ctx));
  pi.registerTool({
    name: "request_user_input", label: "Ask user",
    description: "Ask the user one or more questions during ongoing work. Use only for missing information, preferences, constraints, clarification, or approval. Returns immediately without ending the turn or waiting for a reply; replies arrive later as user follow-up messages. Continue independent work while waiting. Questions remain available if the user does not answer. A preselected option is not submitted automatically. Never interpret silence as an answer or approval.",
    parameters: Type.Object({ questions: Type.Array(Type.Object({
      title: Type.String({ description: "The complete question shown to the user, including any context needed to answer it." }),
      options: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Suggested answers, in display order. Put the recommended answer first; the first option is preselected by default. The user can select one option or enter a free-text answer. Do not include an Other option or a free-text placeholder; the UI provides free-text input automatically. Omit options for a free-text-only question." })),
    }, { additionalProperties: false }), { minItems: 1, description: "One or more self-contained questions to present together, in display order." }) }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "piop-subagent-parent")) throw new Error("Only the root conversation can ask the user");
      if (ctx.mode !== "rpc") throw new Error("Questions require the piop interface");
      validateQuestions(params.questions);
      pi.appendEntry(ENTRY, { id: toolCallId, questions: params.questions } satisfies Request);
      publish(ctx);
      return { content: [{ type: "text", text: '{"accepted":true}' }], details: { accepted: true } };
    },
  });
  pi.registerCommand("piop-answer-question", {
    description: "Deliver a response to a saved question",
    async handler(args, ctx) {
      let id: string | undefined;
      try {
        const command = JSON.parse(args) as ResponseCommand;
        id = command.id;
        if (!id || ctx.mode !== "rpc") throw new Error("Question responses require an RPC request");
        if (!["prepare", "resolve"].includes(command.action)) throw new Error("Invalid question response action");
        const item = requests(ctx).get(command.requestId);
        if (!item) throw new Error("This question is not part of the current conversation");
        const response = item.resolved ? { answers: item.answers, message: undefined } : answerRequest(item, command);
        if (command.action === "resolve" && !item.resolved) {
          pi.appendEntry(ENTRY, { ...item, resolved: true, answers: response.answers });
          publish(ctx);
        }
        ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, success: true, data: { message: response.message } })}`);
      } catch (error) {
        if (id) ctx.ui.setStatus("pi-desktop-control-response", `json:${JSON.stringify({ type: "response", id, success: false, error: String(error) })}`);
      }
    },
  });
}
