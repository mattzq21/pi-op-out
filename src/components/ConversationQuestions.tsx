import { createContext, createMemo, Show, useContext, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import type { ExtensionUiRequest } from "../types";
import { AskUserDialog, isAskUserRequest } from "./AskUserDialog";

type QuestionRequest = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };
export const ConversationQuestionsContext = createContext<{
  requests: Accessor<QuestionRequest[]>;
  respond: (item: QuestionRequest, response: Record<string, unknown>) => Promise<void>;
}>();

export function ConversationQuestions(props: { transport?: NativeTransport }) {
  const context = useContext(ConversationQuestionsContext);
  const pending = createMemo(() => context?.requests().find((item) => item.transport === props.transport && isAskUserRequest(item.request)));
  return <Show when={pending()} keyed>{(item) => <AskUserDialog request={item.request} owner={item.owner} onRespond={(response) => context!.respond(item, response)} />}</Show>;
}
