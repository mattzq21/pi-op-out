import { createSignal, onCleanup, onMount } from "solid-js";
import { invoke, listen } from "./platform";
import type { DictationVad } from "./dictationVad";
import { encodeBase64 } from "./base64";

type Configuration = { enabled: boolean; loading: boolean };

const MAX_SECONDS = 120;

let recordingOwner: symbol | undefined;

export function useDictationEnabled() {
  const [enabled, setEnabled] = createSignal(false);
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => void) | undefined;

  const apply = (state: Configuration) => {
    clearTimeout(timer);
    setEnabled(state.enabled === true && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined");

    if (state.loading) timer = setTimeout(() => void refresh(), 1500);
  };

  const refresh = async () => {
    const request = ++revision;

    try {
      const state = await invoke<Configuration>("dictation_configuration");

      if (!disposed && request === revision) apply(state);
    } catch { if (!disposed && request === revision) apply({ enabled: false, loading: false }); }
  };

  const focus = () => void refresh();
  onMount(() => {
    void listen<Configuration>("pi://dictation", ({ payload }) => {
      if (disposed) return;
      revision++; apply(payload);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    void refresh();
    window.addEventListener("focus", focus);
  });
  onCleanup(() => { disposed = true; clearTimeout(timer); unlisten?.(); window.removeEventListener("focus", focus); });

  return enabled;
}

function wavAudio(chunks: Float32Array[], sampleRate: number) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;

  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }

  const count = Math.min(16000 * MAX_SECONDS, Math.floor(length * 16000 / sampleRate));

  if (!count) throw new Error("No audio was recorded. Try again.");
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };

  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, count * 2, true);
  const ratio = sampleRate / 16000;

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.min(length, Math.floor((i + 1) * ratio)));
    let sum = 0;

    for (let index = start; index < end; index++) sum += samples[index];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }

  return encodeBase64(bytes);
}

export class DictationRecording {
  private owner = Symbol("dictation");
  private stream?: MediaStream;
  private context?: AudioContext;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private chunks: Float32Array[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private vad?: DictationVad;
  private detectionError?: Error;

  async start(onComplete: () => void) {
    if (recordingOwner) throw new Error("Dictation is already recording in another chat.");
    recordingOwner = this.owner;

    try {
      const context = new AudioContext();
      this.context = context;
      await context.resume();

      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });

      if (this.stopped) { stream.getTracks().forEach((track) => track.stop());

      return; }

      this.stream = stream;
      const { DictationVad } = await import("./dictationVad");

      if (this.stopped) return;
      const vad = await DictationVad.create(context.sampleRate);

      if (this.stopped) { vad.close();

      return; }

      this.vad = vad;
      this.source = context.createMediaStreamSource(stream);
      this.processor = context.createScriptProcessor(4096, 1, 1);
      this.gain = context.createGain(); this.gain.gain.value = 0;
      let samples = 0;
      let completionRequested = false;

      const complete = () => {
        if (this.stopped || completionRequested) return;
        completionRequested = true;
        onComplete();
      };

      this.processor.onaudioprocess = (event) => {
        if (this.stopped || completionRequested) return;
        const remaining = MAX_SECONDS * context.sampleRate - samples;

        if (remaining <= 0) { complete();

        return; }

        const chunk = event.inputBuffer.getChannelData(0).slice(0, remaining);
        this.chunks.push(chunk); samples += chunk.length;
        vad.push(chunk, complete, (error) => {
          this.detectionError = new Error(`Speech detection failed: ${error instanceof Error ? error.message : String(error)}`);
          complete();
        });
      };

      this.source.connect(this.processor); this.processor.connect(this.gain); this.gain.connect(context.destination);
      this.timer = setTimeout(complete, MAX_SECONDS * 1000);
    } catch (error) { this.cancel(); throw error; }
  }

  finish() {
    const sampleRate = this.context?.sampleRate;
    this.release();
    const chunks = this.chunks; this.chunks = [];

    if (this.detectionError) throw this.detectionError;

    if (!sampleRate) throw new Error("The microphone was not ready.");

    return wavAudio(chunks, sampleRate);
  }

  cancel() { this.release(); this.chunks = []; }

  private release() {
    this.stopped = true; clearTimeout(this.timer);
    this.vad?.close(); this.vad = undefined;

    if (recordingOwner === this.owner) recordingOwner = undefined;

    if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }

    this.source?.disconnect(); this.gain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => undefined);
  }
}

export const transcribeDictation = (audio: string) => invoke<{ text: string }>("dictation_transcribe", { audio });
