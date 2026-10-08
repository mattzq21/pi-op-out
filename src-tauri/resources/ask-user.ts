import { Type } from "@earendil-works/pi-ai";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY = "piop-async-question";

const STATUS = "piop-async-questions";

const RECOVERY_STATUS = "piop-async-question-recovery";

const questionSchema = Schema.Object({ title: Schema.String(), options: Schema.Optional(Schema.Array(Schema.String())) });

const answersSchema = Schema.Record(Schema.String(), Schema.Object({ answers: Schema.Array(Schema.String()) }));

const requestSchema = Schema.Object({ id: Schema.String(), questions: Schema.Array(questionSchema), resolved: Schema.Optional(Schema.Boolean()), answers: Schema.Optional(answersSchema), queueId: Schema.Optional(Schema.String()) });

const commandSchema = Schema.Object({ requestId: Schema.String(), action: Schema.Union([Schema.Literal("prepare"), Schema.Literal("resolve")]), value: Schema.Optional(Schema.String()), cancelled: Schema.Optional(Schema.Boolean()), queueId: Schema.Optional(Schema.String()) });

const responseSchema = Schema.Object({ answers: Schema.Optional(answersSchema) });

const queuedMessageSchema = Schema.Object({ piopQueueId: Schema.String() });

type Question = Static<typeof questionSchema>;

type Request = Static<typeof requestSchema>;

type ResponseCommand = Static<typeof commandSchema>;

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

function requests(ctx: ExtensionContext) {
  const items = new Map<string, Request>();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const item = Parse(requestSchema, entry.data);
    items.set(item.id, item);
  }

  return items;
}

function publish(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS, JSON.stringify([...requests(ctx).values()].filter((item) => !item.resolved)));
  ctx.ui.setStatus(RECOVERY_STATUS, JSON.stringify(legacyRecovery(ctx.sessionManager.getBranch())));
}

function legacyRequests(branch: Branch) {
  const items = new Map<string, { item: Request; created: number }>();

  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY || !Check(requestSchema, entry.data)) continue;
    const item = entry.data;
    items.set(item.id, { item, created: items.get(item.id)?.created ?? index });
  }

  return [...items.values()];
}

function savedAnswers(branch: Branch) {
  return branch.flatMap((entry, index) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const message = Array.isArray(content) ? content.flatMap(part => part.type === "text" ? [part.text] : []).join("") : content;
    const queueId = Check(queuedMessageSchema, entry.message) ? entry.message.piopQueueId : undefined;

    return [{ index, message, queueId }];
  });
}

function legacyAnswer(item: Request) {
  if (!item.resolved || item.queueId !== undefined || !Check(answersSchema, item.answers)) return;
  const answers = item.answers;

  if (!item.questions.every((_question, index) => answers[`question_${index}`])) return;
  const message = answerMessage(item, answers);

  if (!message) return;

  return {
    id: `question:${item.id}`, message, behavior: "followUp", retry: true, recovered: true,
    questionResponse: { type: "answer_question", requestId: item.id, value: JSON.stringify({ answers: item.answers }), cancelled: false },
  };
}

function consumeSavedAnswer(messages: ReturnType<typeof savedAnswers>, created: number, field: "queueId" | "message", value: string) {
  const index = messages.findIndex(item => item.index >= created && item[field] === value && (field === "queueId" || !item.queueId?.startsWith("question:")));

  if (index < 0) return false;
  messages.splice(index, 1);

  return true;
}

function legacyRecovery(branch: Branch) {
  const messages = savedAnswers(branch);

  const candidates = legacyRequests(branch).flatMap(({ item, created }) => {
    const response = legacyAnswer(item);

    return response ? [{ created, response }] : [];
  });

  const unmatched = candidates.filter(({ created, response }) => !consumeSavedAnswer(messages, created, "queueId", response.id));

  return unmatched.flatMap(({ created, response }) => consumeSavedAnswer(messages, created, "message", response.message) ? [] : [response]);
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
  const response = Parse(responseSchema, JSON.parse(command.value ?? "{}"));

  const answers = Object.fromEntries(item.questions.map((_question, index) => {
    const values = response.answers?.[`question_${index}`]?.answers;

    if (!values) throw new Error("Invalid question answer");

    return [`question_${index}`, { answers: values }];
  }));

  return { answers, message: answerMessage(item, answers) };
}

function answerMessage(item: Request, answers: Static<typeof answersSchema>) {
  const answered = item.questions.flatMap((question, index) => {
    const values = answers[`question_${index}`].answers.filter((value) => value.trim());

    return values.length ? [`${question.title}\n${values.join("\n")}`] : [];
  });

  return answered.length ? `In response to your questions:\n\n${answered.join("\n\n")}` : undefined;
}

export function registerRequestUserInput(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("session_tree", (_event, ctx) => publish(ctx));
  pi.registerTool({
    name: "request_user_input", label: "Ask user",
    exposure: "model-only",
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
  pi.events.on("piop:rpc", request => {
    if (request.command !== "answer_question") return;
    const ctx = request.ctx;
    request.ready = (async () => {
      const command = Parse(commandSchema, request.payload);
      const item = requests(ctx).get(command.requestId);

      if (!item) throw new Error("This question is not part of the current conversation");
      const response = item.resolved ? { answers: item.answers, message: undefined } : answerRequest(item, command);

      if (command.action === "resolve" && (!item.resolved || command.queueId && item.queueId !== command.queueId)) {
        pi.appendEntry(ENTRY, { ...item, resolved: true, answers: response.answers, queueId: command.queueId ?? item.queueId });
        publish(ctx);
      }

      return { message: response.message, queueId: `question:${item.id}` };
    })();
  });
}
