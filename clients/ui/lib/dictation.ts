import { z } from "zod";
import { dictationConfigurationSchema } from "./responseSchemas";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke, listen } from "./platform";
import type { DictationVad } from "./dictationVad";
import { encodeBase64 } from "./base64";

type Configuration = z.output<typeof dictationConfigurationSchema>;

const MAX_SECONDS = 120;

let recordingOwner: symbol | undefined;

const microphoneAvailable = () => !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";

/** Follows the status of the speech engine on this device. */
export function useDictationConfiguration() {
  const [configuration, setConfiguration] = createSignal<Configuration>({ enabled: false, loading: true }, { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) });
  const [error, setError] = createSignal<string>();
  const [listenerError, setListenerError] = createSignal<string>();
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  let listenerFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = (state: Configuration) => {
    clearTimeout(timer);
    setConfiguration(state);
    if (listenerFailed && state.loading) timer = setTimeout(() => void refresh(), 1500);
  };

  const refresh = async () => {
    const request = ++revision;

    try {
      const state = await invoke("dictation_configuration", undefined, dictationConfigurationSchema);

      if (!disposed && request === revision) { apply(state); setError(undefined); }
    } catch (reason) { if (!disposed && request === revision) apply({ enabled: false, loading: false, error: `Could not read the dictation status: ${reason instanceof Error ? reason.message : String(reason)}` }); }
  };

  const focus = () => void refresh();
  const subscribe = () => {
    listenerFailed = false;
    return listen("pi://dictation", ({ payload }) => {
      if (disposed) return;
      revision++; apply(payload); setError(undefined);
    }, dictationConfigurationSchema).then((stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop; setListenerError(undefined);
      return refresh();
    }).catch(reason => {
      if (disposed) return;
      listenerFailed = true;
      setListenerError(`Could not receive dictation settings: ${reason instanceof Error ? reason.message : String(reason)}`);
      return refresh();
    });
  };
  onMount(() => {
    void subscribe();
    window.addEventListener("focus", focus);
  });
  onCleanup(() => { disposed = true; clearTimeout(timer); unlisten?.(); window.removeEventListener("focus", focus); });

  return Object.assign(configuration, { error: () => error() ?? listenerError() ?? configuration().error, retry: () => listenerFailed ? subscribe() : refresh() });
}

export function useDictationEnabled() {
  const configuration = useDictationConfiguration();
  const enabled = createMemo(() => configuration().enabled && microphoneAvailable());

  return { enabled, error: configuration.error, retry: configuration.retry };
}

const streamUpdateSchema = z.object({ id: z.string(), committed: z.string().optional(), tentative: z.string().optional(), error: z.string().optional() });

const FEED_SAMPLES = 4000;

/** Turns microphone samples at any rate into 16 kHz signed 16-bit samples, one piece at a time. */
class Downsampler {
  private buffer = new Float32Array(0);
  private position = 0;

  constructor(private ratio: number) {}

  push(input: Float32Array) {
    const data = new Float32Array(this.buffer.length + input.length);

    data.set(this.buffer); data.set(input, this.buffer.length);
    const output: number[] = [];

    for (;;) {
      const start = Math.floor(this.position), end = Math.max(start + 1, Math.floor(this.position + this.ratio));

      if (end > data.length) break;
      let sum = 0;

      for (let index = start; index < end; index++) sum += data[index];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      output.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
      this.position += this.ratio;
    }

    const keep = Math.floor(this.position);
    this.buffer = data.slice(keep); this.position -= keep;

    return output;
  }
}

function pcmBase64(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));

  return encodeBase64(bytes);
}

export type DictationText = { committed: string; tentative: string };

/** One live dictation: it sends microphone audio to the speech engine on this device while the user speaks and gets text back as it changes. */
export class DictationRecording {
  private owner = Symbol("dictation");
  private stream?: MediaStream;
  private context?: AudioContext;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private vad?: DictationVad;
  private failure?: Error;
  private id?: string;
  /** The engine stream whose text updates this recording shows. It stays set after the user stops, so text keeps arriving while the engine catches up. */
  private streamId?: string;
  private unlisten?: () => void;
  private pending: number[] = [];
  private samples = 0;
  private sending: Promise<void> = Promise.resolve();

  async start(onComplete: () => void, onText: (text: DictationText) => void) {
    if (recordingOwner) throw new Error("Dictation is already recording in another chat.");
    recordingOwner = this.owner;
    let completionRequested = false;

    const complete = () => {
      if (this.stopped || completionRequested) return;
      completionRequested = true;
      onComplete();
    };

    const fail = (error: Error) => { this.failure ??= error; complete(); };
    let started: Promise<{ id: string }> | undefined;

    try {
      this.unlisten = await listen("pi://dictation-stream", ({ payload }) => {
        if (payload.id !== this.streamId) return;

        // After the user stops, finish() reports engine errors, so only text updates apply here.
        if (payload.error !== undefined) { if (!this.stopped) fail(new Error(payload.error)); }
        else onText({ committed: payload.committed ?? "", tentative: payload.tentative ?? "" });
      }, streamUpdateSchema);
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      const { DictationVad } = await import("./dictationVad");
      const vad = await DictationVad.create(context.sampleRate);
      this.vad = vad;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      this.stream = stream;

      if (this.stopped) { this.cancel(); return; }

      // Start the engine stream only after the microphone is granted, so a permission prompt does not hold the engine.
      // Audio recorded while the stream starts waits in `pending` and is sent when the stream ID arrives.
      started = invoke("dictation_stream_start", undefined, z.object({ id: z.string() }));
      const downsampler = new Downsampler(context.sampleRate / 16000);
      this.source = context.createMediaStreamSource(stream);
      this.processor = context.createScriptProcessor(4096, 1, 1);
      this.gain = context.createGain(); this.gain.gain.value = 0;

      this.processor.onaudioprocess = (event) => {
        if (this.stopped || completionRequested) return;
        const remaining = 16000 * MAX_SECONDS - this.samples - this.pending.length;

        if (remaining <= 0) { complete(); return; }

        const chunk = event.inputBuffer.getChannelData(0).slice();
        this.pending.push(...downsampler.push(chunk).slice(0, remaining));

        if (this.pending.length >= FEED_SAMPLES) this.flush(fail);
        vad.push(chunk, complete, (error) => fail(new Error(`Speech detection failed: ${error instanceof Error ? error.message : String(error)}`)));
      };

      this.source.connect(this.processor); this.processor.connect(this.gain); this.gain.connect(context.destination);
      this.timer = setTimeout(complete, MAX_SECONDS * 1000);
      this.id = (await started).id;
      this.streamId = this.id;

      if (this.stopped) { this.cancelStream(); return; }
      this.flush(fail);
    } catch (error) {
      this.cancel();
      if (started && !this.id) void started.then(({ id }) => { this.id = id; this.cancelStream(); }, () => undefined);
      throw error;
    }
  }

  /** Sends the waiting samples. Sends run one after another, so the engine gets the audio in order. */
  private flush(fail: (error: Error) => void) {
    const id = this.id;

    if (!id || !this.pending.length) return;
    const audio = pcmBase64(this.pending);
    this.samples += this.pending.length; this.pending = [];
    this.sending = this.sending.then(() => this.failure ? undefined : invoke("dictation_stream_feed", { id, audio }).then(() => undefined))
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  }

  async finish() {
    const id = this.id;
    this.release();

    try {
      this.flush((error) => { this.failure ??= error; });
      await this.sending;

      if (!id) throw new Error("The microphone was not ready.");

      if (this.failure) { this.cancelStream(); throw this.failure; }

      if (!this.samples) { this.cancelStream(); throw new Error("No audio was recorded. Try again."); }

      this.id = undefined;

      return await invoke("dictation_stream_finish", { id }, z.object({ text: z.string() }));
    } finally { this.stopListening(); }
  }

  cancel() { this.release(); this.stopListening(); this.cancelStream(); }

  private stopListening() { this.streamId = undefined; this.unlisten?.(); this.unlisten = undefined; }

  private cancelStream() {
    const id = this.id;
    this.id = undefined;

    if (id) void invoke("dictation_stream_cancel", { id }).catch((error) => console.error("Could not cancel dictation:", error));
  }

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
