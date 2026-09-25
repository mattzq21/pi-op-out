import { type Accessor, createMemo } from "solid-js";
import { createSubscription } from "../lib/solid";

import type { ChatMessage } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { mergeSpokenMessages, spokenMessage } from "./voiceMessages";
import { voiceSession } from "./voiceSession";

export function useVoiceMessages(messages: Accessor<ChatMessage[]>, transport: Accessor<NativeTransport | undefined> = () => undefined, sessionId: Accessor<string | undefined> = () => undefined) {
  const voice = createSubscription(() => voiceSession.subscribe, () => voiceSession.getSnapshot);
  const owner = createMemo(() => voice().transport);
  const conversation = createMemo(() => voice().sessionId);
  const transcripts = createMemo(() => voice().transcripts);
  const spoken = createMemo(() => transcripts().map(spokenMessage));
  return createMemo(() => owner() === transport() && conversation() === sessionId()
    ? mergeSpokenMessages(messages(), spoken())
    : messages());
}
