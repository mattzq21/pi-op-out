import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './environment';
import * as dictation from './dictation';
import type { DictationEngineKind } from './settings_types';
import type { App } from './app';

/** A speech model that the daemon can save from the internet. size and sha256 prove that the saved file is complete and correct. */
interface CatalogModel { id: string; engine: DictationEngineKind; label: string; file: string; url: string; size: number; sha256: string }

const CATALOG: CatalogModel[] = [
  {
    id: 'whistle', engine: 'needle', label: 'Whistle (English, German, French, Spanish, Italian, Dutch, Polish)', file: 'whistle.cact',
    url: 'https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact', size: 16_919_407,
    sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  },
  {
    id: 'parakeet-unified-en-0.6b-q8_0', engine: 'transcribe.cpp', label: 'Parakeet unified 0.6B, English, streaming (Q8_0)', file: 'parakeet-unified-en-0.6b-Q8_0.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q8_0.gguf', size: 731_357_568,
    sha256: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795',
  },
  {
    id: 'parakeet-unified-en-0.6b-q4_k_m', engine: 'transcribe.cpp', label: 'Parakeet unified 0.6B, English, streaming, smaller (Q4_K_M)', file: 'parakeet-unified-en-0.6b-Q4_K_M.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q4_K_M.gguf', size: 477_274_496,
    sha256: 'a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929',
  },
];

/** One running save. received counts the bytes written so far. */
interface Download { received: number; abort: AbortController }

/** State of the model saves of this daemon. */
export class DictationModels {
  downloads = new Map<string, Download>();
  errors = new Map<string, string>();
}

/** The directory for saved speech models. All daemons of this user share it, so a large model is saved once. */
function directory(): string {
  return join(process.env.XDG_DATA_HOME || join(homeDir(), '.local/share'), 'piop/models/speech');
}

function find(id: string): CatalogModel {
  const model = CATALOG.find(item => item.id === id);
  if (!model) throw new Error(`Unknown speech model ${id}`);
  return model;
}

function savedPath(model: CatalogModel): string | undefined {
  const path = join(directory(), model.file);
  try { return statSync(path).size === model.size ? path : undefined; } catch { return undefined; }
}

/** The catalog with the state of each model on this machine. */
export function list(app: App): any[] {
  const state = app.dictationModels;
  return CATALOG.map(model => {
    const result: any = { id: model.id, engine: model.engine, label: model.label, size: model.size };
    const path = savedPath(model);
    if (path) result.path = path;
    const download = state.downloads.get(model.id);
    if (download) result.received = download.received;
    const error = state.errors.get(model.id);
    if (error !== undefined) result.error = error;
    return result;
  });
}

function publish(app: App): void { app.emit('pi://dictation-models', list(app)); }

/** Starts to save a model. Progress, completion and errors arrive as pi://dictation-models events. */
export function save(app: App, id: string): null {
  const model = find(id);
  const state = app.dictationModels;
  if (state.downloads.has(id)) throw new Error(`${model.label} is already being saved`);
  if (savedPath(model)) throw new Error(`${model.label} is already saved`);
  const download: Download = { received: 0, abort: new AbortController() };
  state.downloads.set(id, download);
  state.errors.delete(id);
  publish(app);
  void run(app, model, download).then(() => {
    state.downloads.delete(id);
    publish(app);
  }, error => {
    state.downloads.delete(id);
    if (!download.abort.signal.aborted) {
      const text = error?.message ?? String(error);
      state.errors.set(id, text);
      console.error(`Could not save ${model.label}: ${text}`);
      app.emit('pi://daemon-error', { hostId: 'local', line: `Could not save ${model.label}: ${text}` });
    }
    publish(app);
  });
  return null;
}

/** Stops a running save and removes its partial file. */
export function cancel(app: App, id: string): null {
  find(id);
  app.dictationModels.downloads.get(id)?.abort.abort();
  return null;
}

/** Removes a saved model file. */
export function remove(app: App, id: string): null {
  const model = find(id);
  if (app.dictationModels.downloads.has(id)) throw new Error(`${model.label} is being saved. Stop the save first.`);
  const path = savedPath(model);
  if (!path) throw new Error(`${model.label} is not saved`);
  unlinkSync(path);
  app.dictationModels.errors.delete(id);
  publish(app);
  // The engine loaded this file, so reload it. The status then shows that the model is missing.
  if (app.dictation.engine?.model === path) dictation.start(app);
  return null;
}

/** Writes the model to a .part file, checks its size and SHA-256, then moves it to its final name. */
async function run(app: App, model: CatalogModel, download: Download): Promise<void> {
  const folder = directory();
  mkdirSync(folder, { recursive: true });
  const part = join(folder, `${model.file}.${process.pid}.${Date.now()}.part`);
  const response = await fetch(model.url, { signal: download.abort.signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`The server answered HTTP ${response.status}`);
  const hash = createHash('sha256');
  const output = createWriteStream(part);
  const closed = new Promise<void>((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); });
  let reported = 0;
  try {
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      if (download.received + chunk.length > model.size) throw new Error('The file is larger than expected');
      hash.update(chunk);
      download.received += chunk.length;
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
      // Publish at each whole percent, so a large model does not flood the clients with events.
      const percent = Math.floor(download.received * 100 / model.size);
      if (percent !== reported) { reported = percent; publish(app); }
    }
    output.end();
    await closed;
    if (download.received !== model.size) throw new Error(`The download stopped after ${download.received} of ${model.size} bytes`);
    if (hash.digest('hex') !== model.sha256) throw new Error('The file checksum is wrong');
    renameSync(part, join(folder, model.file));
  } catch (error) {
    output.destroy();
    try { unlinkSync(part); } catch {}
    throw error;
  }
}
