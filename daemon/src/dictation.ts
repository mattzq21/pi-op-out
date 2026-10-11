import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { homeDir, isFile } from './environment';
import { readSettingsAt } from './settings';
import { settingsPath } from './settings_storage';
import type { App } from './app';

const MAX_AUDIO_BYTES = 44 + 16000 * 2 * 120;
const MAX_TEXT_BYTES = 256 * 1024;

interface Engine { executable: string; model: string }

/** State for the local speech-to-text engine. */
export class DictationRuntime {
  engine: Engine | undefined;
  loading = true;
  generation = 0;
  busy = false;
}

export function configuration(app: App): any {
  return { enabled: app.dictation.engine !== undefined, loading: app.dictation.loading };
}

function publish(app: App): void { app.emit('pi://dictation', configuration(app)); }

export function start(app: App): void {
  const runtime = app.dictation;
  runtime.engine = undefined;
  runtime.loading = true;
  const generation = ++runtime.generation;
  publish(app);
  void (async () => {
    let loaded: Engine | undefined;
    try { loaded = await loadEngine(); } catch (error) { console.error('Could not load dictation engine:', error); }
    if (runtime.generation !== generation) return;
    runtime.engine = loaded;
    runtime.loading = false;
    publish(app);
  })();
}

async function loadEngine(): Promise<Engine | undefined> {
  const [executables, model] = await candidates();
  for (const executable of executables) {
    const engine = { executable, model };
    try { await transcribe(engine, silentWav(), 90_000); return engine; } catch (error) { console.error('Could not initialize dictation engine ' + executable + ':', error); }
  }
  return undefined;
}

async function candidates(): Promise<[string[], string]> {
  const home = homeDir();
  const settings = readSettingsAt(await settingsPath());
  const configured = settings.dictationModelPath;
  if (!configured || !configured.trim()) throw new Error('No dictation model configured');
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

async function transcribe(engine: Engine, wav: Buffer, timeout: number): Promise<string> {
  let directory: string;
  try { directory = mkdtempSync(join(tmpdir(), 'piop-dictation-')); chmodSync(directory, 0o700); }
  catch { throw new Error('Could not prepare dictation audio'); }
  try {
    const audio = join(directory, 'audio.wav');
    const output = join(directory, 'transcript.txt');
    try { writeFileSync(audio, wav); } catch { throw new Error('Could not write dictation audio'); }
    const success = await new Promise<boolean>((resolve, reject) => {
      let child;
      try { child = spawn(engine.executable, ['--model', engine.model, '--quiet', '--output', output, audio], { stdio: 'ignore' }); }
      catch { reject(new Error('Could not start dictation')); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Dictation timed out')); }, timeout);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start dictation')); });
      child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
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
    return { text: await transcribe(engine, wav, 180_000) };
  } finally { runtime.busy = false; }
}
