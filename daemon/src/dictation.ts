import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { homeDir, isFile } from './environment';
import { readSettingsAt } from './settings';
import { settingsPath } from './settings_storage';
import type { AppSettings, DictationEngineKind } from './settings_types';
import type { App } from './app';

const MAX_AUDIO_BYTES = 44 + 16000 * 2 * 120;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 4096;

/** Python code that runs the Cactus Whistle model through the cactus-needle package and writes only the text. */
const NEEDLE_SCRIPT = [
  'import sys',
  'from needle.agent.whistle import Whistle',
  'result = Whistle(weights=sys.argv[1]).transcribe(sys.argv[2])',
  'open(sys.argv[3], "w", encoding="utf-8").write(result["text"])',
].join('\n');

/** A speech-to-text program that the daemon can run. */
interface Engine { kind: DictationEngineKind; executable: string; command: string[]; model: string }

/** State for the local speech-to-text engine. */
export class DictationRuntime {
  engine: Engine | undefined;
  error: string | undefined;
  loading = true;
  generation = 0;
  busy = false;
}

/** The settings that select the engine. A change to any of them reloads the engine. */
export function settingsKey(settings: AppSettings): string {
  return JSON.stringify([settings.dictationEngine, settings.dictationEnginePath, settings.dictationModelPath]);
}

export function configuration(app: App): any {
  const runtime = app.dictation;
  const result: any = { enabled: runtime.engine !== undefined, loading: runtime.loading };
  if (runtime.engine) { result.engine = runtime.engine.kind; result.executable = runtime.engine.executable; }
  if (runtime.error !== undefined) result.error = runtime.error;
  return result;
}

function publish(app: App): void { app.emit('pi://dictation', configuration(app)); }

function report(app: App, message: string): void {
  console.error(message);
  app.emit('pi://daemon-error', { hostId: 'local', line: message });
}

export function start(app: App): void {
  const runtime = app.dictation;
  runtime.engine = undefined;
  runtime.error = undefined;
  runtime.loading = true;
  const generation = ++runtime.generation;
  publish(app);
  void (async () => {
    let loaded: Engine | undefined;
    let error: string | undefined;
    try { loaded = await loadEngine(); } catch (failure: any) { error = failure?.message ?? String(failure); }
    if (runtime.generation !== generation) return;
    runtime.engine = loaded;
    runtime.error = error;
    runtime.loading = false;
    publish(app);
    if (error !== undefined && error !== UNCONFIGURED) report(app, `Dictation is unavailable: ${error}`);
  })();
}

const UNCONFIGURED = 'No dictation model is configured';

async function loadEngine(): Promise<Engine | undefined> {
  const settings = readSettingsAt(await settingsPath());
  const configured = settings.dictationModelPath;
  if (!configured || !configured.trim()) throw new Error(UNCONFIGURED);
  const model = expand(configured);
  if (!isFile(model)) throw new Error(`The model file ${model} does not exist`);
  const executables = candidates(settings.dictationEngine, settings.dictationEnginePath);
  if (!executables.length) throw new Error(settings.dictationEnginePath ? `The program ${expand(settings.dictationEnginePath)} does not exist` : `Could not find ${programName(settings.dictationEngine)}. Install it or set its path.`);
  const failures: string[] = [];
  for (const executable of executables) {
    try {
      const engine = { kind: settings.dictationEngine, executable, command: command(settings.dictationEngine, executable), model };
      await transcribe(engine, silentWav(), 90_000);
      return engine;
    } catch (failure: any) { failures.push(`${executable}: ${failure?.message ?? failure}`); }
  }
  throw new Error(failures.join('\n'));
}

function expand(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('~/') ? join(homeDir(), trimmed.slice(2)) : trimmed;
}

function programName(kind: DictationEngineKind): string { return kind === 'needle' ? 'needle (pip install cactus-needle)' : 'transcribe-cli'; }

function candidates(kind: DictationEngineKind, configured: string | undefined): string[] {
  const home = homeDir();
  const executables: string[] = [];
  if (configured) executables.push(expand(configured));
  else {
    const name = kind === 'needle' ? 'needle' : 'transcribe-cli';
    const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    directories.push(join(home, '.local/bin'), '/usr/local/bin');
    for (const directory of directories) executables.push(join(directory, name));
    if (kind === 'transcribe.cpp') {
      for (const root of [join(home, 'Applications/transcribe.cpp'), join(home, 'transcribe.cpp'), join(home, 'src/transcribe.cpp')]) {
        for (const build of ['build', 'build-cuda', 'build-vulkan', 'build-release']) executables.push(join(root, build, 'bin', name));
      }
    }
  }
  const seen = new Set<string>();
  return executables.filter(path => {
    if (!isFile(path)) return false;
    try { const real = realpathSync(path); if (seen.has(real)) return false; seen.add(real); return true; } catch { return false; }
  });
}

/** Returns the program and the first arguments. Needle is a Python script, so its own interpreter runs our script. */
function command(kind: DictationEngineKind, executable: string): string[] {
  if (kind === 'transcribe.cpp') return [executable];
  let first: string;
  try { first = readFileSync(executable, 'utf8').split('\n', 1)[0]; } catch { throw new Error('Could not read the needle program'); }
  if (!first.startsWith('#!')) throw new Error('The needle program is not a Python script');
  const parts = first.slice(2).trim().split(/\s+/).filter(Boolean);
  const interpreter = parts[0]?.endsWith('/env') ? parts.slice(1) : parts;
  if (!interpreter.length || !/python[0-9.]*$/.test(interpreter[0])) throw new Error('The needle program does not name a Python interpreter');
  return [...interpreter, '-c', NEEDLE_SCRIPT];
}

function readTranscript(output: string): string {
  let size: number;
  try { size = statSync(output).size; } catch { throw new Error('Dictation returned no transcript'); }
  if (size > MAX_TEXT_BYTES) throw new Error('Dictation returned too much text');
  try { return readFileSync(output, 'utf8').trim(); } catch { throw new Error('Could not read the transcript'); }
}

function lastErrorLine(stderr: string): string | undefined {
  return stderr.split('\n').map(line => line.trim()).filter(Boolean).pop();
}

async function transcribe(engine: Engine, wav: Buffer, timeout: number): Promise<string> {
  let directory: string;
  try { directory = mkdtempSync(join(tmpdir(), 'piop-dictation-')); chmodSync(directory, 0o700); }
  catch { throw new Error('Could not prepare dictation audio'); }
  try {
    const audio = join(directory, 'audio.wav');
    const output = join(directory, 'transcript.txt');
    try { writeFileSync(audio, wav); } catch { throw new Error('Could not write dictation audio'); }
    const [program, ...prefix] = engine.command;
    const args = engine.kind === 'needle' ? [...prefix, engine.model, audio, output] : [...prefix, '--model', engine.model, '--quiet', '--output', output, audio];
    const env = engine.kind === 'needle' ? { ...process.env, NEEDLE_TELEMETRY: '0' } : process.env;
    const [code, stderr] = await new Promise<[number | null, string]>((resolve, reject) => {
      let child;
      try { child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'], env }); }
      catch { reject(new Error('Could not start dictation')); return; }
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_ERROR_BYTES); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Dictation timed out')); }, timeout);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start dictation')); });
      child.on('close', code => { clearTimeout(timer); resolve([code, stderr]); });
    });
    if (code !== 0) throw new Error(`The speech model could not transcribe this recording${lastErrorLine(stderr) ? `: ${lastErrorLine(stderr)}` : ''}`);
    return readTranscript(output);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
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
  } catch (error: any) {
    runtime.engine = undefined;
    runtime.error = error?.message ?? String(error);
    publish(app);
    throw error;
  } finally { runtime.busy = false; }
}
