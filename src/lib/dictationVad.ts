import { env, InferenceSession, Tensor } from "onnxruntime-web/wasm";
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import modelBase64 from "../assets/silero-vad.base64?raw";

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;

class SpeechEndpoint {
  private active = false;
  private confirmed = false;
  private voiceSamples = 0;
  private silentSamples = 0;

  accept(probability: number) {
    if (probability >= 0.5) this.active = true;
    else if (probability < 0.35) this.active = false;
    if (this.active) {
      this.voiceSamples += FRAME_SIZE;
      this.silentSamples = 0;
      if (this.voiceSamples >= SAMPLE_RATE * 0.1) this.confirmed = true;
    } else {
      this.voiceSamples = 0;
      if (this.confirmed) this.silentSamples += FRAME_SIZE;
    }
    return this.silentSamples >= SAMPLE_RATE * 1.5;
  }
}

export class DictationVad {
  private context = new Float32Array(64);
  private state = new Float32Array(256);
  private frame = new Float32Array(FRAME_SIZE);
  private frameOffset = 0;
  private weight = 0;
  private sum = 0;
  private endpoint = new SpeechEndpoint();
  private pending = Promise.resolve();
  private closed = false;

  private constructor(private session: InferenceSession, private sampleRate: number) {}

  static async create(sampleRate: number) {
    env.wasm.numThreads = 1;
    env.wasm.wasmPaths = { wasm: new URL(wasmUrl, window.location.href).href };
    const binary = atob(modelBase64.replace(/\s/g, ""));
    const model = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const session = await InferenceSession.create(model, { executionProviders: ["wasm"] });
    return new DictationVad(session, sampleRate);
  }

  push(chunk: Float32Array, onComplete: () => void, onError: (error: unknown) => void) {
    this.pending = this.pending.then(async () => {
      if (this.closed) return;
      await this.consume(chunk, onComplete);
    }).catch((error: unknown) => { if (!this.closed) onError(error); });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void this.pending.then(() => this.session.release()).catch(() => undefined);
  }

  private async consume(chunk: Float32Array, onComplete: () => void) {
    const ratio = this.sampleRate / SAMPLE_RATE;
    for (const sample of chunk) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const amount = Math.min(remaining, ratio - this.weight);
        this.sum += sample * amount;
        this.weight += amount;
        remaining -= amount;
        if (this.weight < ratio - 1e-8) continue;
        this.frame[this.frameOffset++] = this.sum / ratio;
        this.sum = 0; this.weight = 0;
        if (this.frameOffset !== FRAME_SIZE) continue;
        this.frameOffset = 0;
        if (this.closed) return;
        if (await this.detect()) { onComplete(); return; }
      }
    }
  }

  private async detect() {
    const input = new Float32Array(64 + FRAME_SIZE);
    input.set(this.context); input.set(this.frame, 64);
    const feeds = {
      input: new Tensor("float32", input, [1, input.length]),
      state: new Tensor("float32", this.state, [2, 1, 128]),
      sr: new Tensor("int64", BigInt64Array.of(16000n), [1]),
    };
    try {
      const outputs = await this.session.run(feeds);
      try {
        this.state.set(outputs.stateN.data as Float32Array);
        this.context.set(this.frame.subarray(FRAME_SIZE - 64));
        return this.endpoint.accept(Number(outputs.output.data[0]));
      } finally { Object.values(outputs).forEach((tensor) => tensor.dispose()); }
    } finally { Object.values(feeds).forEach((tensor) => tensor.dispose()); }
  }
}
