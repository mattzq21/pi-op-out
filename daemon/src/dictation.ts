import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { homeDir, isFile } from './environment';
import { readSettingsAt } from './settings';
import { settingsPath } from './settings_storage';
import type { App } from './app';
import { stopMessageWorker } from './process_cleanup';

const MAX_AUDIO_BYTES = 44 + 16000 * 2 * 120;
const MAX_TEXT_BYTES = 256 * 1024;

interface Engine { executable: string; model: string }

/** State for the local speech-to-text engine. */
export class DictationRuntime {
  engine: Engine | undefined;
  loading = true;
  /** Why no engine is available; null while loading or when one is. */
  error: string | null = null;
  generation = 0;
  busy = false;
  stopped = false;
  children = new Map<ChildProcess, Promise<void> | undefined>();
}

export function configuration(app: App): any {
  return { enabled: app.dictation.engine !== undefined, loading: app.dictation.loading, error: app.dictation.error };
}

function publish(app: App): void { app.emit('pi://dictation', configuration(app)); }

export function start(app: App): void {
  const runtime = app.dictation;
  if (runtime.stopped) return;
  const previous = [...runtime.children.keys()].map(child => stopChild(runtime, child));
  runtime.engine = undefined;
  runtime.loading = true;
  runtime.error = null;
  const generation = ++runtime.generation;
  publish(app);
  void (async () => {
    let loaded: Engine | undefined;
    let error: string | null = null;
    try {
      await Promise.all(previous);
      if (runtime.generation !== generation) return;
      loaded = await loadEngine(runtime, generation);
    } catch (failure: any) {
      error = failure?.message ?? String(failure);
      if (!(failure instanceof NotConfigured)) console.error('Could not load dictation engine:', failure);
    }
    if (runtime.generation !== generation) return;
    runtime.engine = loaded;
    runtime.error = loaded ? null : error ?? 'No working dictation engine was found';
    runtime.loading = false;
    publish(app);
  })();
}

function stopChild(runtime: DictationRuntime, child: ChildProcess): Promise<void> {
  const pending = runtime.children.get(child);
  if (pending) return pending;
  const stopping = stopMessageWorker(child).finally(() => { runtime.children.delete(child); });
  runtime.children.set(child, stopping);
  return stopping;
}

export async function stop(app: App): Promise<void> {
  const runtime = app.dictation;
  runtime.stopped = true;
  runtime.generation += 1;
  runtime.engine = undefined;
  runtime.loading = false;
  runtime.error = 'Dictation is stopped';
  await Promise.all([...runtime.children.keys()].map(child => stopChild(runtime, child)));
}

/** Dictation has no model; the user has not set one up. */
class NotConfigured extends Error {}

async function loadEngine(runtime: DictationRuntime, generation: number): Promise<Engine | undefined> {
  const [executables, model] = await candidates();
  if (!executables.length) throw new Error('No transcribe-cli executable was found');
  let last: string | null = null;
  for (const executable of executables) {
    if (runtime.generation !== generation) return;
    const engine = { executable, model };
    try { await transcribe(runtime, engine, silentWav(), 90_000); return engine; }
    catch (error: any) { last = executable + ': ' + (error?.message ?? String(error)); console.error('Could not initialize dictation engine ' + last); }
  }
  if (runtime.generation !== generation) return;
  throw new Error('Could not initialize dictation engine ' + last);
}

async function candidates(): Promise<[string[], string]> {
  const home = homeDir();
  const settings = readSettingsAt(await settingsPath());
  const configured = settings.dictationModelPath;
  if (!configured || !configured.trim()) throw new NotConfigured('No dictation model configured');
  const model = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured;
  if (!isFile(model)) throw new Error('Dictation model is not a file');
  const name = 'transcribe-cli';
  const executables: string[] = [];
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  directories.push(join(home, '.local/bin'), '/usr/local/bin');
  for (const directory of directories) executables.push(join(directory, name));
  for (const root of [join(home, 'Applications/transcribe.cpp'), join(home, 'transcribe.cpp'), join(home, 'src/transcribe.cpp')]) {
    for (const build of ['build', 'build-cuda', 'build-vulkan', 'build-metal', 'build-release']) {
      executables.push(join(root, build, 'bin', name), join(root, build, 'bin/Release', name));
    }
  }
  const seen = new Set<string>();
  const found = executables.filter(path => {
    if (!isFile(path)) return false;
    try { const real = realpathSync(path); if (seen.has(real)) return false; seen.add(real); return true; } catch (error) { console.error('Could not inspect dictation executable ' + path + ':', error); return false; }
  });
  return [found, model];
}

function readTranscript(output: string): string {
  let size: number;
  try { size = statSync(output).size; } catch { throw new Error('Dictation returned no transcript'); }
  if (size > MAX_TEXT_BYTES) throw new Error('Dictation returned too much text');
  try { return readFileSync(output, 'utf8').trim(); } catch { throw new Error('Could not read the transcript'); }
}

async function transcribe(runtime: DictationRuntime, engine: Engine, wav: Buffer, timeout: number): Promise<string> {
  let directory: string;
  try { directory = mkdtempSync(join(tmpdir(), 'piop-dictation-')); chmodSync(directory, 0o700); }
  catch { throw new Error('Could not prepare dictation audio'); }
  try {
    const audio = join(directory, 'audio.wav');
    const output = join(directory, 'transcript.txt');
    try { writeFileSync(audio, wav); } catch { throw new Error('Could not write dictation audio'); }
    const success = await new Promise<boolean>((resolve, reject) => {
      let child;
      try { child = spawn(engine.executable, ['--model', engine.model, '--quiet', '--output', output, audio], { stdio: 'ignore', detached: true }); }
      catch { reject(new Error('Could not start dictation')); return; }
      runtime.children.set(child, undefined);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void stopChild(runtime, child).then(() => reject(new Error('Dictation timed out')), error => { console.error('Could not stop dictation:', error); reject(error); });
      }, timeout);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start dictation')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (!runtime.children.get(child)) runtime.children.delete(child);
        if (timedOut) reject(new Error('Dictation timed out')); else resolve(code === 0);
      });
    });
    if (!success) throw new Error('The speech model could not transcribe this recording');
    return readTranscript(output);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch (error) { console.error('Could not remove dictation audio ' + directory + ':', error); } }
}

function silentWav(): Buffer {
  const size = 16000 * 2;
  const wav = Buffer.alloc(size + 44);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(size + 36, 4); wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(size, 40);
  return wav;
}

function validateWav(wav: Buffer): void {
  if (wav.length < 46 || wav.length > MAX_AUDIO_BYTES || wav.length % 2 !== 0) throw new Error('Invalid dictation recording length');
  const header = silentWav();
  if (!wav.subarray(0, 4).equals(header.subarray(0, 4)) || !wav.subarray(8, 40).equals(header.subarray(8, 40))
    || wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(40) !== wav.length - 44) throw new Error('Dictation requires 16 kHz mono PCM audio');
}

export async function dictate(app: App, audio: string): Promise<any> {
  if (typeof audio !== 'string') throw new Error('Invalid dictation audio');
  if (audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new Error('Dictation recording is too long');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio) || audio.length % 4 !== 0) throw new Error('Invalid dictation audio');
  const wav = Buffer.from(audio, 'base64');
  validateWav(wav);
  const runtime = app.dictation;
  if (runtime.busy) throw new Error('Dictation is busy. Try again shortly.');
  const engine = runtime.engine;
  if (!engine) throw new Error('Dictation is unavailable');
  runtime.busy = true;
  try {
    return { text: await transcribe(runtime, engine, wav, 180_000) };
  } finally { runtime.busy = false; }
}
