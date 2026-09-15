import { useState, useSyncExternalStore } from "react";
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import type { AgentState, ChatMessage } from "../types";
import type { NativeTransport } from "../lib/nativeTransport";
import { voiceConfiguration, voiceSession, type VoiceSnapshot } from "../lib/voiceSession";

interface Props { transport: NativeTransport; state: AgentState; messages: ChatMessage[]; disabled?: boolean }
const phaseLabel = { idle: "Voice", connecting: "Connecting voice…", connected: "Voice connected", closing: "Ending voice…" };

function AudioButtons({ voice, busy, run }: { voice: VoiceSnapshot; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const disabled = busy || voice.phase !== "connected";
  return <>
    <button type="button" disabled={disabled} aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={voice.muted} onClick={() => void run(() => voiceSession.mute(!voice.muted))}>{voice.muted ? <MicOff size={14} /> : <Mic size={14} />}</button>
    <meter aria-label="Microphone level" min={0} max={32767} value={voice.microphone} />
    <button type="button" disabled={disabled} aria-label={voice.suppressed ? "Enable voice playback" : "Mute voice playback"} aria-pressed={voice.suppressed} onClick={() => void run(() => voiceSession.suppress(!voice.suppressed))}>{voice.suppressed ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
  </>;
}

function CallToolbar({ voice, ownsCall, busy, run }: { voice: VoiceSnapshot; ownsCall: boolean; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  return <>
    <span role="status">{ownsCall ? phaseLabel[voice.phase] : `Voice: ${voice.label}`}</span>
    {ownsCall && <AudioButtons voice={voice} busy={busy} run={run} />}
    <button type="button" disabled={busy || voice.phase === "closing"} onClick={() => void run(() => voiceSession.stop())}><PhoneOff size={14} />End call</button>
  </>;
}

export function VoiceControls({ transport, state, messages, disabled }: Props) {
  const voice = useSyncExternalStore(voiceSession.subscribe, voiceSession.getSnapshot);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ownsCall = voice.transport === transport && voice.sessionId === state.sessionId;
  const active = voice.phase !== "idle";
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const start = async () => {
    const config = await voiceConfiguration();
    if (!config.authenticated) throw new Error(config.error || "Sign in with codex login to use voice.");
    if (!config.helperAvailable) throw new Error("The voice helper is missing. Rebuild Piop with voice support.");
    await voiceSession.start(transport, state, messages);
  };
  const visibleError = error || (ownsCall ? voice.error : undefined);
  return <div className="voice-controls">
    <div className="voice-toolbar">
      {active ? <CallToolbar voice={voice} ownsCall={ownsCall} busy={busy} run={run} /> : <>
        <button type="button" disabled={disabled || busy} onClick={() => void run(start)}><Mic size={14} />Voice</button>
      </>}
    </div>
    {visibleError && <div className="voice-error" role="alert">{visibleError}</div>}
  </div>;
}
