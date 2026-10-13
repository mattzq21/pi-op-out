/** Session log entry type. A request is saved when asked and saved again, resolved, when answered. */
export const QUESTION_ENTRY = "piop-async-question";

/** Status key the extension sets with a JSON array of unresolved requests. */
export const PENDING_QUESTIONS_STATUS_KEY = "piop-async-questions";

/** Status key the extension sets with a JSON array of saved answers that never reached the conversation. */
export const QUESTION_RECOVERY_STATUS_KEY = "piop-async-question-recovery";

/** Piop request command that prepares or resolves an answer. */
export const ANSWER_QUESTION_COMMAND = "answer_question";

/** Queue item ID that carries the answer to one request. */
export function questionQueueId(requestId: string): string {
  return `question:${requestId}`;
}

export type Question = { title: string; options?: string[] };

/** Answers keyed by question_<index>. */
export type QuestionAnswers = Record<string, { answers: string[] }>;

/** Log entry data. queueId names the queue item that delivered the answer. */
export type QuestionRequest = { id: string; questions: Question[]; resolved?: boolean; answers?: QuestionAnswers; queueId?: string };

/**
 * Payload of ANSWER_QUESTION_COMMAND. value is JSON { answers: QuestionAnswers }.
 * "prepare" returns the answer message. "resolve" marks the request resolved and records queueId.
 */
export type AnswerQuestionCommand = { requestId: string; action: "prepare" | "resolve"; value?: string; cancelled?: boolean; queueId?: string };

/** message is undefined when cancelled, already resolved, or every answer is empty. */
export type AnswerQuestionResult = { message?: string; queueId: string };

/** Answer the queue must deliver again. questionResponse is replayed as an ANSWER_QUESTION_COMMAND. */
export type RecoveredAnswer = {
  id: string; message: string; behavior: "followUp"; retry: true; recovered: true;
  questionResponse: { type: typeof ANSWER_QUESTION_COMMAND; requestId: string; value: string; cancelled: false };
};
