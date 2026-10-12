import { Mic, Square, X } from "lucide-solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { DictationRecording, useDictationEnabled } from "../lib/dictation";

export function DictationControls(props: { disabled: boolean; compact?: boolean; onText: (text: string) => void }) {
  const configuration = useDictationEnabled();
  const enabled = configuration.enabled;
  const [phase, setPhase] = createSignal<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [error, setError] = createSignal<string>();
  const [committed, setCommitted] = createSignal("");
  const [tentative, setTentative] = createSignal("");
  let recording: DictationRecording | undefined;
  let generation = 0;

  const cancel = () => { generation++; recording?.cancel(); recording = undefined;

  setPhase("idle"); setCommitted(""); setTentative(""); };

  onCleanup(cancel);
  createEffect(() => { if (props.disabled) cancel(); });
  createEffect(() => { if (!enabled() && (phase() === "starting" || phase() === "recording")) cancel(); });

  const finish = async () => {
    if (phase() !== "recording" || !recording) return;
    const current = generation;
    setPhase("transcribing");

    try {
      const capture = recording;
      const result = await capture.finish();

      if (current === generation && !props.disabled && result?.text.trim()) props.onText(result.text.trim());
    } catch (reason) { if (current === generation) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current === generation) { recording = undefined; setPhase("idle"); setCommitted(""); setTentative(""); } }
  };

  const start = async () => {
    if (!enabled() || props.disabled || phase() !== "idle") return;
    const current = ++generation;
    const capture = new DictationRecording(message => setError(message)); recording = capture;
    setError(undefined); setCommitted(""); setTentative(""); setPhase("starting");

    try { await capture.start(() => void finish(), (text) => { if (current === generation) { setCommitted(text.committed); setTentative(text.tentative); } });

    if (current === generation) setPhase("recording"); }
    catch (reason) {
      if (current === generation) { recording = undefined; setPhase("idle"); setError(reason instanceof Error ? reason.message : String(reason)); }
    }
  };

  const showLabel = () => !props.compact || phase() !== "idle";

  return <span class="dictation-controls">
    <Show when={enabled()}>
      <button type="button" class={phase() === "recording" ? "dictation-recording" : ""} aria-label={phase() === "recording" ? "Stop dictation" : "Dictate"} aria-pressed={phase() === "recording"} disabled={props.disabled || phase() === "starting" || phase() === "transcribing"} onClick={() => void (phase() === "recording" ? finish() : start())}>
        {phase() === "recording" ? <Square size={14} /> : <Mic size={14} />}
        <Show when={showLabel()}><span class="dictation-label">{phase() === "recording" ? "Stop dictation" : phase() === "transcribing" ? "Transcribing…" : phase() === "starting" ? "Microphone…" : "Dictate"}</span></Show>
      </button>
      <Show when={phase() !== "idle"}><button type="button" aria-label="Cancel dictation" onClick={cancel}><X size={14} /></button></Show>
    </Show>
    <Show when={committed() || tentative()}><span class="dictation-live" aria-live="polite">{committed().length > 160 ? "…" + committed().slice(-160) : committed()}<span class="dictation-tentative">{committed() && tentative() ? " " : ""}{tentative()}</span></span></Show>
    <Show when={configuration.error()}><span class="dictation-error" role="alert">{configuration.error()} <button type="button" onClick={() => void configuration.retry()}>Retry</button></span></Show>
    <Show when={error()}><span class="dictation-error" role="alert">{error()}</span></Show>
  </span>;
}
