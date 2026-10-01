import { required } from "../lib/required";
import { createComputed, createContext, createMemo, For, useContext, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import type { ExtensionUiRequest } from "../types";
import { AskUserDialog, createQuestionDraft, isAskUserRequest } from "./AskUserDialog";

type QuestionRequest = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };

export function createConversationQuestions(requests: Accessor<QuestionRequest[]>, remove: (item: QuestionRequest) => void) {
  const drafts = new Map<string, ReturnType<typeof createQuestionDraft>>();
  createComputed(() => {
    const pending = new Set(requests().map(item => item.queueId));

    for (const key of drafts.keys()) if (!pending.has(key)) drafts.delete(key);
  });

  const draft = (item: QuestionRequest) => {
    let saved = drafts.get(item.queueId);

    if (!saved) { saved = createQuestionDraft(item.request); drafts.set(item.queueId, saved); }

    return saved;
  };

  return { requests, draft, respond: async (item: QuestionRequest, response: Record<string, unknown>) => {
    await item.transport.command({ type: "extension_ui_response", id: item.request.id, ...response });
    drafts.delete(item.queueId);
    remove(item);
  } };
}

export const ConversationQuestionsContext = createContext<{
  requests: Accessor<QuestionRequest[]>;
  draft: (item: QuestionRequest) => ReturnType<typeof createQuestionDraft>;
  respond: (item: QuestionRequest, response: Record<string, unknown>) => Promise<void>;
}>();

export function ConversationQuestions(props: { transport?: NativeTransport }) {
  const context = useContext(ConversationQuestionsContext);
  const pending = createMemo(() => context?.requests().filter((item) => item.transport === props.transport && isAskUserRequest(item.request)));

  return <For each={pending()}>{(item) => <AskUserDialog request={item.request} draft={required(context).draft(item)} owner={item.owner} onRespond={(response) => required(context).respond(item, response)} />}</For>;
}
