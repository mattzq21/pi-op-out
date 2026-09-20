import { createMemo, createSignal } from "solid-js";
import { createSubscription } from "../lib/solid";

import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-solid";
import type { NativeTransport } from "../lib/nativeTransport";
import { voiceConfiguration, voiceSession, type VoiceSnapshot } from "../lib/voiceSession";
import type { AgentState, ChatMessage } from "../types";

interface Props { transport: NativeTransport; state: AgentState; messages: ChatMessage[]; disabled?: boolean }
const phaseLabel = { idle: "Voice", connecting: "Connecting voice…", connected: "Voice connected", closing: "Ending voice…" };

function AudioButtons(componentProps: { voice: VoiceSnapshot; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const disabled = createMemo(() => (componentProps.busy || componentProps.voice.phase !== "connected"));
  return <>
    <button type="button" disabled={disabled()} aria-label={componentProps.voice.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={componentProps.voice.muted} onClick={() => void componentProps.run(() => voiceSession.mute(!componentProps.voice.muted))}>{componentProps.voice.muted ? <MicOff size={14} /> : <Mic size={14} />}</button>
    <meter aria-label="Microphone level" min={0} max={32767} value={componentProps.voice.microphone} />
    <button type="button" disabled={disabled()} aria-label={componentProps.voice.suppressed ? "Enable voice playback" : "Mute voice playback"} aria-pressed={componentProps.voice.suppressed} onClick={() => void componentProps.run(() => voiceSession.suppress(!componentProps.voice.suppressed))}>{componentProps.voice.suppressed ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
  </>;
}

function CallToolbar(componentProps: { voice: VoiceSnapshot; ownsCall: boolean; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  return <>
    <span role="status">{componentProps.ownsCall ? phaseLabel[componentProps.voice.phase] : `Voice: ${componentProps.voice.label}`}</span>
    {componentProps.ownsCall && <AudioButtons voice={componentProps.voice} busy={componentProps.busy} run={componentProps.run} />}
    <button type="button" disabled={componentProps.busy || componentProps.voice.phase === "closing"} onClick={() => void componentProps.run(() => voiceSession.stop())}><PhoneOff size={14} />End call</button>
  </>;
}

export function VoiceControls(componentProps: Props) {
  const voice = createSubscription(() => voiceSession.subscribe, () => voiceSession.getSnapshot);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const ownsCall = createMemo(() => (voice().transport === componentProps.transport && voice().sessionId === componentProps.state.sessionId));
  const active = createMemo(() => (voice().phase !== "idle"));
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const run = async (action: () => Promise<unknown>) => { const capturedBusy = busy();
    if (capturedBusy) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const start = async () => { const capturedTransport0 = componentProps.transport; const capturedState1 = componentProps.state;
    const config = await voiceConfiguration(capturedTransport0);
    if (!config.authenticated) throw new Error(config.error || "Sign in with codex login to use voice.");
    if (!config.helperAvailable) throw new Error("The voice helper is missing. Rebuild Piop with voice support.");
    await voiceSession.start(capturedTransport0, capturedState1);
  };
  const visibleError = createMemo(() => (error() || (ownsCall() ? voice().error : undefined)));
  return <div class="voice-controls">
    <div class="voice-toolbar">
      {active() ? <CallToolbar voice={voice()} ownsCall={ownsCall()} busy={busy()} run={run} /> : <>
        <button type="button" disabled={componentProps.disabled || busy()} onClick={() => void run(start)}><Mic size={14} />Voice</button>
      </>}
    </div>
    {visibleError() && <div class="voice-error" role="alert">{(visibleError())!}</div>}
  </div>;
}
