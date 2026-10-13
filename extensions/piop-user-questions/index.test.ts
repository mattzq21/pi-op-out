import { expect, test } from "bun:test";
import userQuestions from "./index.ts";
import { PENDING_QUESTIONS_STATUS_KEY, QUESTION_ENTRY, QUESTION_RECOVERY_STATUS_KEY } from "./interface.ts";

function host(mode = "rpc") {
  const entries: any[] = [], statuses = new Map<string, any>(), handlers = new Map<string, Function>();
  const tools = new Map<string, any>(), rpc: Function[] = [];
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { on: (_name: string, handler: Function) => rpc.push(handler) },
  };
  const ctx: any = { mode, sessionManager: { getBranch: () => entries }, ui: { setStatus: (key: string, value: string) => statuses.set(key, JSON.parse(value)) } };
  userQuestions(pi);
  const ask = (id: string, questions: any[]) => tools.get("request_user_input").execute(id, { questions }, undefined, undefined, ctx);
  const answer = async (payload: any) => { const request: any = { command: "answer_question", payload, ctx }; for (const handler of rpc) handler(request); return request.ready; };
  return { entries, statuses, ctx, ask, answer, start: () => handlers.get("session_start")!({}, ctx) };
}

const value = (...answers: string[][]) => JSON.stringify({ answers: Object.fromEntries(answers.map((list, index) => [`question_${index}`, { answers: list }])) });

test("an answer is prepared, then resolved once per queue item", async () => {
  const h = host();
  await h.ask("call-1", [{ title: "Color?", options: ["Red"] }, { title: "Size?" }]);
  expect(h.statuses.get(PENDING_QUESTIONS_STATUS_KEY).map((item: any) => item.id)).toEqual(["call-1"]);
  const prepared = await h.answer({ requestId: "call-1", action: "prepare", value: value(["Red"], [" "]) });
  expect(prepared).toEqual({ message: "In response to your questions:\n\nColor?\nRed", queueId: "question:call-1" });
  expect(h.entries).toHaveLength(1);
  await h.answer({ requestId: "call-1", action: "resolve", value: value(["Red"], [""]), queueId: "q1" });
  await h.answer({ requestId: "call-1", action: "resolve", queueId: "q1" });
  expect(h.entries).toHaveLength(2);
  expect(h.entries[1].data).toMatchObject({ resolved: true, queueId: "q1", answers: { question_0: { answers: ["Red"] } } });
  expect(h.statuses.get(PENDING_QUESTIONS_STATUS_KEY)).toEqual([]);
  expect(await h.answer({ requestId: "call-1", action: "prepare" })).toEqual({ message: undefined, queueId: "question:call-1" });
});

test("a cancel resolves without a message and bad answers fail", async () => {
  const h = host();
  await h.ask("call-1", [{ title: "Name?" }]);
  await expect(h.answer({ requestId: "call-1", action: "resolve", value: value() })).rejects.toThrow("Invalid question answer");
  await expect(h.answer({ requestId: "other", action: "prepare" })).rejects.toThrow("not part of the current conversation");
  expect(await h.answer({ requestId: "call-1", action: "resolve", cancelled: true })).toEqual({ message: undefined, queueId: "question:call-1" });
  expect(h.entries[1].data).toMatchObject({ resolved: true, answers: {} });
});

test("only a root Piop conversation can ask valid questions", async () => {
  await expect(host("print").ask("a", [{ title: "Q?" }])).rejects.toThrow("piop interface");
  const h = host();
  await expect(h.ask("a", [{ title: " " }])).rejects.toThrow("titles must not be empty");
  await expect(h.ask("a", [{ title: "Q?", options: [""] }])).rejects.toThrow("non-empty answer");
  h.entries.push({ type: "custom", customType: "piop-subagent-parent", data: {} });
  await expect(h.ask("a", [{ title: "Q?" }])).rejects.toThrow("root conversation");
  expect(h.entries).toHaveLength(1);
});

test("an answer saved without a queue item is recovered until its message is in the conversation", () => {
  const h = host();
  const request = { id: "call-1", questions: [{ title: "Name?" }] };
  h.entries.push({ type: "custom", customType: QUESTION_ENTRY, data: request });
  h.entries.push({ type: "custom", customType: QUESTION_ENTRY, data: { ...request, resolved: true, answers: { question_0: { answers: ["Ada"] } } } });
  h.start();
  const message = "In response to your questions:\n\nName?\nAda";
  expect(h.statuses.get(QUESTION_RECOVERY_STATUS_KEY)).toEqual([{
    id: "question:call-1", message, behavior: "followUp", retry: true, recovered: true,
    questionResponse: { type: "answer_question", requestId: "call-1", value: JSON.stringify({ answers: { question_0: { answers: ["Ada"] } } }), cancelled: false },
  }]);
  h.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: message }] } });
  h.start();
  expect(h.statuses.get(QUESTION_RECOVERY_STATUS_KEY)).toEqual([]);
});
