import { createContext, createMemo, For, useContext, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import type { ExtensionUiRequest } from "../types";
import { AskUserDialog, isAskUserRequest } from "./AskUserDialog";

type QuestionRequest = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };
export function createConversationQuestions(requests: Accessor<QuestionRequest[]>, remove: (item: QuestionRequest) => void) {
  return { requests, respond: async (item: QuestionRequest, response: Record<string, unknown>) => {
    await item.transport.command({ type: "extension_ui_response", id: item.request.id, ...response });
    remove(item);
  } };
}
export const ConversationQuestionsContext = createContext<{
  requests: Accessor<QuestionRequest[]>;
  respond: (item: QuestionRequest, response: Record<string, unknown>) => Promise<void>;
}>();

export function ConversationQuestions(props: { transport?: NativeTransport }) {
  const context = useContext(ConversationQuestionsContext);
  const pending = createMemo(() => context?.requests().filter((item) => item.transport === props.transport && isAskUserRequest(item.request)));
  return <For each={pending()}>{(item) => <AskUserDialog request={item.request} owner={item.owner} onRespond={(response) => context!.respond(item, response)} />}</For>;
}
