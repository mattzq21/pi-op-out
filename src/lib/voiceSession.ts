import { invoke, listen, isMobile, type UnlistenFn } from "./platform";
import type { AgentState } from "../types";
import type { NativeTransport } from "./nativeTransport";
import type { SpokenMessage } from "./voiceMessages";

export type VoicePhase = "idle" | "connecting" | "connected" | "closing";
export type VoiceTranscript = SpokenMessage;
export interface VoiceSnapshot {
  phase: VoicePhase;
  transport?: NativeTransport;
  sessionId?: string;
  label?: string;
  error?: string;
  muted: boolean;
  suppressed: boolean;
  microphone: number;
  speaker: number;
  transcripts: VoiceTranscript[];
}
type VoiceEnvelope = { callId: string; event: Record<string, unknown> };
export interface VoiceConfiguration { authenticated: boolean; helperAvailable: boolean; error?: string }
export const voiceConfiguration = (transport: NativeTransport) => invoke<VoiceConfiguration>("voice_configuration", { runtimeId: transport.voiceRuntimeId() });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const initial: VoiceSnapshot = { phase: "idle", muted: false, suppressed: false, microphone: 0, speaker: 0, transcripts: [] };

export class VoiceSession {
  private snapshot: VoiceSnapshot = initial;
  private listeners = new Set<() => void>();
  private id?: string;
  private unlisten?: UnlistenFn;
  private unsubscribeAgent?: () => void;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(update: Partial<VoiceSnapshot>) { this.snapshot = { ...this.snapshot, ...update }; this.listeners.forEach((listener) => listener()); }
  private report(error: unknown) { this.update({ error: errorText(error) }); }
  connectionLost() { if (this.id) { this.cleanup(); this.report("Host connection ended. Start a new voice call after reconnecting."); } }

  async start(transport: NativeTransport, state: AgentState) {
    if (this.snapshot.phase !== "idle") throw new Error("End the current voice call first");
    if (!state.sessionId || !transport.ownsConversation()) throw new Error("Connect and take ownership of this conversation before starting voice");
    const id = crypto.randomUUID(); this.id = id;
    this.update({ ...initial, phase: "connecting", transport, sessionId: state.sessionId, label: state.sessionName || transport.connectionTarget().cwd || "This conversation" });
    try {
      const unlisten = await listen<VoiceEnvelope>("pi://voice", ({ payload }) => { if (payload.callId === this.id) this.onVoiceEvent(payload.event); });
      if (this.id !== id) { unlisten(); return; }
      this.unlisten = unlisten;
      this.unsubscribeAgent = transport.subscribe((event) => {
        if (["ownership_lost", "disconnected", "session_switched"].includes(event.type)) void this.stop().catch(() => this.cleanup());
      });
      if (this.isClosing()) { this.cleanup(); return; }
      await invoke("voice_start", { callId: id, runtimeId: transport.voiceRuntimeId() });
    } catch (error) {
      if (this.id === id) { this.cleanup(); this.report(error); }
      throw error;
    }
  }
  async stop() {
    const callId = this.id;
    if (!callId) return;
    this.update({ phase: "closing" });
    try { await invoke("voice_stop", { callId, runtimeId: this.snapshot.transport?.voiceRuntimeId() }); }
    finally { if (isMobile && this.id === callId) this.cleanup(); }
  }
  private isClosing() { return this.snapshot.phase === "closing"; }
  async mute(muted: boolean) { await invoke("voice_mute", { callId: this.id, runtimeId: this.snapshot.transport?.voiceRuntimeId(), muted }); }
  async suppress(suppressed: boolean) { await invoke("voice_suppress", { callId: this.id, runtimeId: this.snapshot.transport?.voiceRuntimeId(), suppressed }); }
  private cleanup() {
    this.id = undefined;
    this.unlisten?.(); this.unlisten = undefined;
    this.unsubscribeAgent?.(); this.unsubscribeAgent = undefined;
    this.update({ phase: "idle", microphone: 0, speaker: 0 });
  }
  private onVoiceEvent(event: Record<string, unknown>) {
    this.voiceHandlers[String(event.type)]?.(event);
  }
  private voiceHandlers: Record<string, (event: Record<string, unknown>) => void> = {
    connecting: () => this.advance("connecting"),
    connected: () => this.advance("connected"),
    closing: () => this.advance("closing"),
    ended: () => this.cleanup(),
    error: (event) => this.report(event.message ?? "Voice session failed"),
    muted: (event) => this.update({ muted: event.muted === true }),
    suppressed: (event) => this.update({ suppressed: event.suppressed === true }),
    levels: (event) => this.update({ microphone: Number(event.microphone) || 0, speaker: Number(event.speaker) || 0 }),
    transcript: (event) => this.transcript(event.turn as VoiceTranscript),
  };
  private advance(phase: VoicePhase) { if (!this.isClosing()) this.update({ phase }); }
  private transcript(turn: VoiceTranscript) {
      if (!turn || typeof turn.id !== "string" || typeof turn.text !== "string") return;
      const previous = this.snapshot.transcripts;
      this.update({ transcripts: previous.some((entry) => entry.id === turn.id) ? previous.map((entry) => entry.id === turn.id ? turn : entry) : [...previous.slice(-99), turn] });
  }
}
export const voiceSession = new VoiceSession();
