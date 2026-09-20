import { type Accessor, createMemo } from "solid-js";
import { createSubscription } from "../lib/solid";

import type { ChatMessage } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { mergeSpokenMessages, spokenMessage } from "./voiceMessages";
import { voiceSession } from "./voiceSession";

export function useVoiceMessages(messages: Accessor<ChatMessage[]>, transport: Accessor<NativeTransport | undefined> = () => undefined, sessionId: Accessor<string | undefined> = () => undefined) {
  const voice = createSubscription(() => voiceSession.subscribe, () => voiceSession.getSnapshot);
  return createMemo(() => voice().transport === transport() && voice().sessionId === sessionId()
    ? mergeSpokenMessages(messages(), voice().transcripts.map(spokenMessage))
    : messages());
}
