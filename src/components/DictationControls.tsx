import { Mic, Square, X } from "lucide-solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { DictationRecording, transcribeDictation, useDictationEnabled } from "../lib/dictation";
import { createSubscription } from "../lib/solid";
import { voiceSession } from "../lib/voiceSession";

export function DictationControls(props: { disabled: boolean; onText: (text: string) => void }) {
  const enabled = useDictationEnabled();
  const voice = createSubscription(() => voiceSession.subscribe, () => voiceSession.getSnapshot);
  const [phase, setPhase] = createSignal<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [error, setError] = createSignal<string>();
  let recording: DictationRecording | undefined;
  let generation = 0;
  const cancel = () => { generation++; recording?.cancel(); recording = undefined; setPhase("idle"); };
  onCleanup(cancel);
  createEffect(() => { if (props.disabled || voice().phase !== "idle") cancel(); });
  createEffect(() => { if (!enabled() && (phase() === "starting" || phase() === "recording")) cancel(); });
  const finish = async () => {
    if (phase() !== "recording" || !recording) return;
    const current = generation;
    setPhase("transcribing");
    try {
      const audio = recording.finish(); recording = undefined;
      const result = await transcribeDictation(audio);
      if (current === generation && !props.disabled && result.text.trim()) props.onText(result.text.trim());
    } catch (reason) { if (current === generation) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current === generation) setPhase("idle"); }
  };
  const start = async () => {
    if (!enabled() || props.disabled || phase() !== "idle" || voice().phase !== "idle") return;
    const current = ++generation;
    const capture = new DictationRecording(); recording = capture;
    setError(undefined); setPhase("starting");
    try { await capture.start(() => void finish()); if (current === generation) setPhase("recording"); }
    catch (reason) {
      if (current === generation) { recording = undefined; setPhase("idle"); setError(reason instanceof Error ? reason.message : String(reason)); }
    }
  };
  return <span class="dictation-controls">
    <Show when={enabled()}>
      <button type="button" class={phase() === "recording" ? "dictation-recording" : ""} aria-label={phase() === "recording" ? "Stop dictation" : "Dictate"} aria-pressed={phase() === "recording"} disabled={props.disabled || voice().phase !== "idle" || phase() === "starting" || phase() === "transcribing"} onClick={() => void (phase() === "recording" ? finish() : start())}>
        {phase() === "recording" ? <Square size={14} /> : <Mic size={14} />}
        {phase() === "recording" ? "Stop dictation" : phase() === "transcribing" ? "Transcribing…" : phase() === "starting" ? "Microphone…" : "Dictate"}
      </button>
      <Show when={phase() !== "idle"}><button type="button" aria-label="Cancel dictation" onClick={cancel}><X size={14} /></button></Show>
    </Show>
    <Show when={error()}><span class="dictation-error" role="alert">{error()}</span></Show>
  </span>;
}
