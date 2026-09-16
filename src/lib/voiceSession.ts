import { invoke, listen, isMobile, type UnlistenFn } from "./platform";
import type { AgentState, ChatMessage, RpcEvent } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { voicePrompt, type SpokenMessage } from "./voiceMessages";
import { textOf } from "./content";

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
type Delegation = { id: string; prompt: string };
type VoiceEnvelope = { callId: string; event: Record<string, unknown> };
export interface VoiceConfiguration { authenticated: boolean; helperAvailable: boolean; error?: string }
export const voiceConfiguration = () => invoke<VoiceConfiguration>("voice_configuration");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const initial: VoiceSnapshot = { phase: "idle", muted: false, suppressed: false, microphone: 0, speaker: 0, transcripts: [] };

function startupContext(state: AgentState, messages: ChatMessage[], transport: NativeTransport) {
  const turns = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-8);
  const history = turns.map((message) => `${message.role}: ${textOf(message.content).slice(-1200)}`).join("\n");
  return `Project: ${transport.connectionTarget().cwd ?? "No project selected"}\nAgent working: ${state.isStreaming}\nRecent conversation:\n${history}`;
}

function openTranscriptIndex(transcripts: VoiceTranscript[], role: VoiceTranscript["role"]) {
  for (let index = transcripts.length - 1; index >= 0; index--) {
    if (transcripts[index].role === role && !transcripts[index].completed) return index;
  }
  return -1;
}

function appendTranscript(previous: VoiceTranscript[], event: Record<string, unknown>, role: VoiceTranscript["role"]) {
  if (typeof event.delta !== "string" || !event.delta) return previous;
  const startMs = typeof event.start_ms === "number" ? event.start_ms : Date.now();
  const endMs = typeof event.end_ms === "number" ? event.end_ms : startMs;
  const index = openTranscriptIndex(previous, role);
  const last = previous[index];
  const next = { id: crypto.randomUUID(), role, text: event.delta, startMs, endMs };
  if (last) return previous.map((entry, i) => i === index ? { ...last, text: (last.text + event.delta).slice(-8000), endMs } : entry);
  return [...previous.slice(-99), next];
}

function finalAssistant(event: RpcEvent) {
  if (event.type !== "message_end") return;
  const message = event.message as ChatMessage | undefined;
  if (message?.role !== "assistant" || message.stopReason === "toolUse") return;
  if (message.stopReason === "aborted" || message.stopReason === "error") return message.errorMessage || "The agent stopped before completing the request.";
  if (Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall")) return;
  return textOf(message.content).trim();
}

function delegatedPrompt(transcript: string, spoken?: VoiceTranscript) {
  return voicePrompt(spoken?.id ?? crypto.randomUUID(), spoken?.text || transcript);
}

export class VoiceSession {
  private snapshot: VoiceSnapshot = initial;
  private listeners = new Set<() => void>();
  private id?: string;
  private sessionId?: string;
  private unlisten?: UnlistenFn;
  private unsubscribeAgent?: () => void;
  private pending: Delegation[] = [];
  private seen = new Set<string>();
  private active?: string;
  private lastAnswer?: string;
  private eventQueue: Promise<void> = Promise.resolve();
  private lastToolUpdate = 0;
  private historyQueue: Promise<void> = Promise.resolve();

  connectionLost() { if (this.id) { this.cleanup(); this.report("Host connection ended. Start a new voice call after reconnecting."); } }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(update: Partial<VoiceSnapshot>) { this.snapshot = { ...this.snapshot, ...update }; this.listeners.forEach((listener) => listener()); }
  private report(error: unknown) { this.update({ error: errorText(error) }); }

  async start(transport: NativeTransport, state: AgentState, messages: ChatMessage[]) {
    if (this.snapshot.phase !== "idle") throw new Error("End the current voice call first");
    if (!state.sessionId) throw new Error("Wait for this conversation to connect before starting voice");
    const id = crypto.randomUUID(); this.id = id; this.sessionId = state.sessionId;
    this.pending = []; this.seen.clear(); this.active = undefined; this.lastAnswer = undefined;
    this.eventQueue = Promise.resolve();
    this.update({ ...initial, phase: "connecting", transport, sessionId: state.sessionId, label: state.sessionName || transport.connectionTarget().cwd || "This conversation" });
    try {
      this.unlisten = await listen<VoiceEnvelope>("pi://voice", ({ payload }) => {
        if (payload.callId === this.id) this.onVoiceEvent(payload.event);
      });
      if (this.isClosing()) { this.cleanup(); return; }
      this.unsubscribeAgent = transport.subscribe((event) => this.onAgentEvent(event));
      await invoke("voice_start", { callId: id, context: startupContext(state, messages, transport) });
      if (this.isClosing()) await invoke("voice_stop", { callId: id });
    } catch (error) {
      if (this.id === id) { this.cleanup(); this.report(error); }
      throw error;
    }
  }

  private isClosing() { return this.snapshot.phase === "closing"; }
  private advance(phase: VoicePhase) { if (!this.isClosing()) this.update({ phase }); }
  private reportForCall(callId: string | undefined, error: unknown) { if (callId === this.id) this.report(error); }

  async stop() {
    if (!this.id) return;
    this.update({ phase: "closing" });
    const callId = this.id;
    try { await invoke("voice_stop", { callId }); } finally { if (isMobile && this.id === callId) this.cleanup(); }
  }
  async mute(muted: boolean) { await invoke("voice_mute", { callId: this.id, muted }); }
  async suppress(suppressed: boolean) { await invoke("voice_suppress", { callId: this.id, suppressed }); }

  private cleanup() {
    const transcripts = this.snapshot.transcripts.map((turn) => {
      if (turn.completed) return turn;
      const completed = { ...turn, completed: true, endMs: Date.now() };
      this.persist(completed);
      return completed;
    });
    this.update({ transcripts });
    this.id = undefined; this.active = undefined; this.pending = [];
    this.unlisten?.(); this.unlisten = undefined;
    this.unsubscribeAgent?.(); this.unsubscribeAgent = undefined;
    this.update({ phase: "idle", microphone: 0, speaker: 0 });
  }

  private onVoiceEvent(event: Record<string, unknown>) {
    const handler = this.voiceHandlers[String(event.type)];
    handler?.(event);
  }
  private voiceHandlers: Record<string, (event: Record<string, unknown>) => void> = {
    connecting: () => this.advance("connecting"),
    connected: () => this.advance("connected"),
    closing: () => this.update({ phase: "closing" }),
    ended: () => this.cleanup(),
    error: (event) => this.report(event.message ?? "Voice session failed"),
    "session.error": () => this.report("The voice service reported an error"),
    muted: (event) => this.update({ muted: event.muted === true }),
    suppressed: (event) => this.update({ suppressed: event.suppressed === true }),
    levels: (event) => this.update({ microphone: Number(event.microphone) || 0, speaker: Number(event.speaker) || 0 }),
    "input_transcript.added": (event) => this.transcript({ delta: (event.item as { text?: string })?.text }, "user"),
    "output_transcript.added": (event) => this.transcript({ delta: (event.item as { text?: string })?.text }, "assistant"),
    "turn.done": (event) => this.completeTranscript(event),
    "delegation.created": (event) => this.enqueueDelegation(event),
  };

  private transcript(event: Record<string, unknown>, role: VoiceTranscript["role"]) {
    this.update({ transcripts: appendTranscript(this.snapshot.transcripts, event, role) });
  }

  private completeTranscript(event: Record<string, unknown>) {
    const turn = event.turn as { role?: string; transcript?: string } | undefined;
    if (!turn || !["user", "assistant"].includes(turn.role ?? "") || typeof turn.transcript !== "string") return;
    const role = turn.role as VoiceTranscript["role"];
    const entries = this.snapshot.transcripts;
    const index = openTranscriptIndex(entries, role);
    const entry = { id: entries[index]?.id ?? crypto.randomUUID(), role, text: turn.transcript.slice(-8000), startMs: entries[index]?.startMs ?? Date.now(), endMs: Date.now(), completed: true };
    this.update({ transcripts: index >= 0 ? entries.map((previous, i) => i === index ? entry : previous) : [...entries.slice(-99), entry] });
    this.persist(entry);
  }

  private persist(turn: VoiceTranscript) {
    const { transport, sessionId } = this.snapshot;
    const callId = this.id;
    if (!transport || !sessionId || !turn.text.trim()) return;
    this.historyQueue = this.historyQueue.then(async () => {
      await transport.command({ type: "voice_history", sessionId, turn });
    }).catch((error) => this.reportForCall(callId, error));
  }

  private enqueueDelegation(event: Record<string, unknown>) {
    if (this.snapshot.phase !== "connected") return;
    const delegation = event.item as { type?: string; id?: string; target?: string; content?: { type?: string; text?: string }[] } | undefined;
    if (delegation?.type !== "delegation" || delegation.target !== "client" || typeof delegation.id !== "string" || this.seen.has(delegation.id)) return;
    const id = delegation.id; this.seen.add(id);
    if (this.seen.size > 512) { void this.stop().catch((error) => this.report(error)); this.report("Start a new voice call to continue this long conversation."); return; }
    const transcript = (delegation.content ?? []).filter((part) => part.type === "input_text" && typeof part.text === "string").map((part) => part.text).join("").slice(-12000);
    const callId = this.id;
    const spoken = [...this.snapshot.transcripts].reverse().find((turn) => turn.role === "user");
    this.eventQueue = this.eventQueue.then(() => this.delegate(callId, id, transcript, spoken)).catch((error) => this.reportForCall(callId, error));
  }

  private async delegate(callId: string | undefined, id: string, transcript: string, spoken?: VoiceTranscript) {
    if (this.id !== callId || this.snapshot.phase !== "connected") return;
    if (!transcript) { await this.context("The spoken request has not arrived yet. Please ask the user to repeat it.", id, true); return; }
    const transport = this.snapshot.transport!;
    const state = await transport.command<AgentState>({ type: "get_state" });
    if (this.id !== callId || this.isClosing() || state.sessionId !== this.sessionId) return;
    const prompt = delegatedPrompt(transcript, spoken);
    this.pending.push({ id, prompt });
    try { await transport.command({ type: "steer", message: prompt }); }
    catch (error) {
      this.pending = this.pending.filter((entry) => entry.id !== id);
      if (this.id === callId) await this.context(`The request could not be delivered to the coding agent: ${errorText(error).slice(0,500)}`, id, true);
      throw error;
    }
  }

  private onAgentEvent(event: RpcEvent) {
    if (event.type === "disconnected") { void this.stop().catch((error) => this.report(error)); return; }
    this.acceptUserMessage(event);
    const answer = finalAssistant(event);
    if (answer && this.active) this.lastAnswer = answer;
    if (event.type === "agent_settled") this.finishDelegation();
    if (event.type === "tool_execution_start") this.toolProgress(event);
  }

  private acceptUserMessage(event: RpcEvent) {
    if (event.type !== "message_start") return;
    const message = event.message as ChatMessage | undefined;
    if (message?.role !== "user") return;
    const text = textOf(message.content);
    const pending = this.pending.find((entry) => entry.prompt === text);
    this.active = pending?.id;
    this.lastAnswer = undefined;
    if (pending) this.pending = this.pending.filter((entry) => entry !== pending);
  }

  private finishDelegation() {
    const callId = this.id;
    const id = this.active; const answer = this.lastAnswer;
    this.active = undefined; this.lastAnswer = undefined;
    if (id && answer) void this.context(answer.slice(0,8000), id, true).catch((error) => this.reportForCall(callId, error));
  }

  private toolProgress(event: RpcEvent) {
    if (!this.active || Date.now() - this.lastToolUpdate < 3000) return;
    const callId = this.id;
    this.lastToolUpdate = Date.now();
    void this.context(`The coding agent is using ${String(event.toolName).slice(0,80)}. It has not finished yet.`, this.active, false).catch((error) => this.reportForCall(callId, error));
  }

  private async context(text: string, delegationId: string, speak: boolean) {
    if (!this.id || this.snapshot.phase !== "connected") return;
    await invoke("voice_context", { callId: this.id, text, delegationId, speak });
  }
}

export const voiceSession = new VoiceSession();
