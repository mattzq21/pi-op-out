import { useMemo, useSyncExternalStore } from "react";
import type { ChatMessage } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { voiceSession } from "./voiceSession";
import { mergeSpokenMessages, spokenMessage } from "./voiceMessages";

export function useVoiceMessages(messages: ChatMessage[], transport?: NativeTransport, sessionId?: string) {
  const voice = useSyncExternalStore(voiceSession.subscribe, voiceSession.getSnapshot);
  return useMemo(() => voice.transport === transport && voice.sessionId === sessionId
    ? mergeSpokenMessages(messages, voice.transcripts.map(spokenMessage))
    : messages, [messages, transport, sessionId, voice.transport, voice.sessionId, voice.transcripts]);
}
