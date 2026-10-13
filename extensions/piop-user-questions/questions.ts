import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import {
  ANSWER_QUESTION_COMMAND, QUESTION_ENTRY, questionQueueId,
  type AnswerQuestionCommand, type AnswerQuestionResult, type Question, type QuestionAnswers, type QuestionRequest, type RecoveredAnswer,
} from "./interface.ts";

/** Session branch entries, oldest first. */
export type Entry =
  | { type: "custom"; customType: string; data?: unknown }
  | { type: "message"; message: { role: string; content?: unknown; piopQueueId?: unknown } }
  | { type: string };

const questionSchema = Type.Object({ title: Type.String(), options: Type.Optional(Type.Array(Type.String())) });

const answersSchema = Type.Record(Type.String(), Type.Object({ answers: Type.Array(Type.String()) }));

const requestSchema = Type.Object({ id: Type.String(), questions: Type.Array(questionSchema), resolved: Type.Optional(Type.Boolean()), answers: Type.Optional(answersSchema), queueId: Type.Optional(Type.String()) });

const responseSchema = Type.Object({ answers: Type.Optional(answersSchema) });

const queuedMessageSchema = Type.Object({ piopQueueId: Type.String() });

function custom(entry: Entry): entry is { type: "custom"; customType: string; data?: unknown } {
  return entry.type === "custom" && "customType" in entry && entry.customType === QUESTION_ENTRY;
}

function requests(branch: Entry[]) {
  const items = new Map<string, QuestionRequest>();

  for (const entry of branch) {
    if (!custom(entry)) continue;
    const item = Parse(requestSchema, entry.data);
    items.set(item.id, item);
  }

  return items;
}

/** Unresolved requests on the branch. Throws on a damaged entry. */
export function pendingRequests(branch: Entry[]): QuestionRequest[] {
  return [...requests(branch).values()].filter(item => !item.resolved);
}

/** Checks a new request. Throws with a reason the model can act on. */
export function newRequest(id: string, questions: Question[]): QuestionRequest {
  if (!questions.length) throw new Error("questions must not be empty");

  for (const question of questions) {
    if (!question.title.trim()) throw new Error("question titles must not be empty");

    if (question.options && (!question.options.length || question.options.some(option => !option.trim()))) throw new Error("options must contain at least one non-empty answer");
  }

  return { id, questions };
}

/**
 * Applies an answer command to the branch. record is the entry to save, if any.
 * Throws when the request is not on the branch or the answer does not cover every question.
 */
export function answerRequest(branch: Entry[], command: AnswerQuestionCommand): { record?: QuestionRequest; result: AnswerQuestionResult } {
  const item = requests(branch).get(command.requestId);

  if (!item) throw new Error("This question is not part of the current conversation");
  const response = item.resolved ? { answers: item.answers, message: undefined } : parseAnswer(item, command);
  const result = { message: response.message, queueId: questionQueueId(item.id) };

  if (command.action !== "resolve" || item.resolved && (!command.queueId || item.queueId === command.queueId)) return { result };

  return { record: { ...item, resolved: true, answers: response.answers, queueId: command.queueId ?? item.queueId }, result };
}

function parseAnswer(item: QuestionRequest, command: AnswerQuestionCommand) {
  if (command.cancelled) return { answers: {}, message: undefined };
  const response = Parse(responseSchema, JSON.parse(command.value ?? "{}"));

  const answers = Object.fromEntries(item.questions.map((_question, index) => {
    const values = response.answers?.[`question_${index}`]?.answers;

    if (!values) throw new Error("Invalid question answer");

    return [`question_${index}`, { answers: values }];
  }));

  return { answers, message: answerMessage(item, answers) };
}

/** The user message that delivers the answers. undefined when every answer is empty. */
export function answerMessage(item: QuestionRequest, answers: QuestionAnswers): string | undefined {
  const answered = item.questions.flatMap((question, index) => {
    const values = answers[`question_${index}`].answers.filter(value => value.trim());

    return values.length ? [`${question.title}\n${values.join("\n")}`] : [];
  });

  return answered.length ? `In response to your questions:\n\n${answered.join("\n\n")}` : undefined;
}

/** Resolved requests saved without a queue item whose answer message is not on the branch. */
export function recoverableAnswers(branch: Entry[]): RecoveredAnswer[] {
  const messages = userMessages(branch);

  const candidates = firstRequests(branch).flatMap(({ item, created }) => {
    const response = recoveredAnswer(item);

    return response ? [{ created, response }] : [];
  });

  const unmatched = candidates.filter(({ created, response }) => !consumeMessage(messages, created, "queueId", response.id));

  return unmatched.flatMap(({ created, response }) => consumeMessage(messages, created, "message", response.message) ? [] : [response]);
}

function firstRequests(branch: Entry[]) {
  const items = new Map<string, { item: QuestionRequest; created: number }>();

  for (const [index, entry] of branch.entries()) {
    if (!custom(entry) || !Check(requestSchema, entry.data)) continue;
    const item = entry.data;
    items.set(item.id, { item, created: items.get(item.id)?.created ?? index });
  }

  return [...items.values()];
}

function userMessages(branch: Entry[]) {
  return branch.flatMap((entry, index) => {
    if (entry.type !== "message" || !("message" in entry) || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const message = Array.isArray(content) ? content.flatMap(part => part?.type === "text" ? [String(part.text)] : []).join("") : content;
    const queueId = Check(queuedMessageSchema, entry.message) ? entry.message.piopQueueId : undefined;

    return [{ index, message, queueId }];
  });
}

function recoveredAnswer(item: QuestionRequest): RecoveredAnswer | undefined {
  if (!item.resolved || item.queueId !== undefined || !Check(answersSchema, item.answers)) return;
  const answers: Static<typeof answersSchema> = item.answers;

  if (!item.questions.every((_question, index) => answers[`question_${index}`])) return;
  const message = answerMessage(item, answers);

  if (!message) return;

  return {
    id: questionQueueId(item.id), message, behavior: "followUp", retry: true, recovered: true,
    questionResponse: { type: ANSWER_QUESTION_COMMAND, requestId: item.id, value: JSON.stringify({ answers }), cancelled: false },
  };
}

function consumeMessage(messages: ReturnType<typeof userMessages>, created: number, field: "queueId" | "message", value: string) {
  const index = messages.findIndex(item => item.index >= created && item[field] === value && (field === "queueId" || !item.queueId?.startsWith(questionQueueId(""))));

  if (index < 0) return false;
  messages.splice(index, 1);

  return true;
}
