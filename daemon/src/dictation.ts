import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import worker from '../resources/dictation-worker.py?raw';
import { homeDir, isFile } from './environment';
import { readSettingsAt } from './settings';
import { settingsPath } from './settings_storage';
import type { AppSettings, DictationEngineKind } from './settings_types';
import type { App } from './app';

const BYTES_PER_SECOND = 16000 * 2;
const MAX_STREAM_BYTES = BYTES_PER_SECOND * 120;
const MAX_FEED_BYTES = BYTES_PER_SECOND * 5;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 4096;
const IDLE_MS = 30_000;
const PROBE_MS = 120_000;
const FINISH_MS = 120_000;
const UNCONFIGURED = 'No dictation model is configured';

/** A speech-to-text setup that the daemon can run: the Python interpreter command and the model file. */
interface Engine { kind: DictationEngineKind; executable: string; interpreter: string[]; model: string }

/** A running dictation worker process. It gets raw 16 kHz mono 16-bit audio and sends back live text. */
interface Worker { write(audio: Buffer): void; end(): void; kill(): void; done: Promise<string> }

/** One live dictation from one client. */
interface Stream { id: string; owner: string; worker: Worker; bytes: number; idle?: ReturnType<typeof setTimeout>; finishing: boolean }

/** State for the local speech-to-text engine. */
export class DictationRuntime {
  engine: Engine | undefined;
  error: string | undefined;
  loading = true;
  generation = 0;
  streams = new Map<string, Stream>();
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

function message(error: any): string { return error?.message ?? String(error); }

export function start(app: App): void {
  const runtime = app.dictation;
  for (const stream of [...runtime.streams.values()]) close(app, stream, 'Dictation stopped because the speech engine changed');
  runtime.engine = undefined;
  runtime.error = undefined;
  runtime.loading = true;
  const generation = ++runtime.generation;
  publish(app);
  void (async () => {
    let loaded: Engine | undefined;
    let error: string | undefined;
    try { loaded = await loadEngine(); } catch (failure) { error = message(failure); }
    if (runtime.generation !== generation) return;
    runtime.engine = loaded;
    runtime.error = error;
    runtime.loading = false;
    publish(app);
    if (error !== undefined && error !== UNCONFIGURED) report(app, `Dictation is unavailable: ${error}`);
  })();
}

async function loadEngine(): Promise<Engine> {
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
      const engine = { kind: settings.dictationEngine, executable, interpreter: interpreter(settings.dictationEngine, executable), model };
      await probe(engine);
      return engine;
    } catch (failure) { failures.push(`${executable}: ${message(failure)}`); }
  }
  throw new Error(failures.join('\n'));
}

/** Runs one second of silence through the engine to prove that the program and the model load. */
async function probe(engine: Engine): Promise<void> {
  const running = spawnWorker(engine, () => undefined);
  running.write(Buffer.alloc(BYTES_PER_SECOND));
  running.end();
  await deadline(running, PROBE_MS, 'The speech engine did not start in time');
}

function deadline(running: Worker, timeout: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { running.kill(); reject(new Error(text)); }, timeout);
    running.done.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function expand(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('~/') ? join(homeDir(), trimmed.slice(2)) : trimmed;
}

function programName(kind: DictationEngineKind): string {
  return kind === 'needle' ? 'needle (pip install cactus-needle)' : 'a Python with transcribe-cpp (pip install transcribe-cpp)';
}

function candidates(kind: DictationEngineKind, configured: string | undefined): string[] {
  const home = homeDir();
  const executables: string[] = [];
  if (configured) executables.push(expand(configured));
  else {
    const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    directories.push(join(home, '.local/bin'), '/usr/local/bin');
    if (kind === 'needle') for (const directory of directories) executables.push(join(directory, 'needle'));
    else {
      executables.push(join(home, '.local/share/transcribe-cpp/venv/bin/python'));
      for (const directory of directories) executables.push(join(directory, 'python3'));
    }
  }
  const seen = new Set<string>();
  return executables.filter(path => {
    if (!isFile(path)) return false;
    try { const real = realpathSync(path); if (seen.has(real)) return false; seen.add(real); return true; } catch { return false; }
  });
}

/** Returns the Python command. For Needle, it is the interpreter named in the needle script's first line. */
function interpreter(kind: DictationEngineKind, executable: string): string[] {
  if (kind === 'transcribe.cpp') return [executable];
  let first: string;
  try { first = readFileSync(executable, 'utf8').split('\n', 1)[0]; } catch { throw new Error('Could not read the needle program'); }
  if (!first.startsWith('#!')) throw new Error('The needle program is not a Python script');
  const parts = first.slice(2).trim().split(/\s+/).filter(Boolean);
  const command = parts[0]?.endsWith('/env') ? parts.slice(1) : parts;
  if (!command.length || !/python[0-9.]*$/.test(command[0])) throw new Error('The needle program does not name a Python interpreter');
  return command;
}

function lastLine(text: string): string | undefined { return text.split('\n').map(line => line.trim()).filter(Boolean).pop(); }

function spawnWorker(engine: Engine, onText: (committed: string, tentative: string) => void): Worker {
  const [program, ...prefix] = engine.interpreter;
  const env = { ...process.env, NEEDLE_TELEMETRY: '0', PYTHONUNBUFFERED: '1' };
  const child = spawn(program, [...prefix, '-c', worker, engine.kind, engine.model], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stderr = '';
  let line = '';
  let final: string | undefined;
  let protocolError: string | undefined;
  const done = new Promise<string>((resolve, reject) => {
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_ERROR_BYTES); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      line += chunk;
      let index: number;
      while ((index = line.indexOf('\n')) >= 0) {
        const text = line.slice(0, index); line = line.slice(index + 1);
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { protocolError = 'The speech engine sent invalid output'; child.kill('SIGKILL'); return; }
        if (parsed?.type === 'text' && typeof parsed.committed === 'string' && typeof parsed.tentative === 'string') onText(parsed.committed, parsed.tentative);
        else if (parsed?.type === 'final' && typeof parsed.text === 'string') final = parsed.text.trim();
      }
      if (line.length > MAX_LINE_BYTES) { protocolError = 'The speech engine sent too much text'; child.kill('SIGKILL'); }
    });
    child.on('error', error => reject(new Error(`Could not start the speech engine: ${error.message}`)));
    child.on('close', code => {
      if (protocolError) reject(new Error(protocolError));
      else if (code === 0 && final !== undefined) resolve(final);
      else reject(new Error(`The speech engine failed${lastLine(stderr) ? `: ${lastLine(stderr)}` : ` with exit code ${code}`}`));
    });
  });
  return {
    write: audio => { child.stdin.write(audio); },
    end: () => { child.stdin.end(); },
    kill: () => { child.kill('SIGKILL'); },
    done,
  };
}

function uniqueId(streams: Map<string, Stream>): string {
  for (;;) { const id = randomUUID(); if (!streams.has(id)) return id; }
}

function close(app: App, stream: Stream, error?: string): void {
  if (app.dictation.streams.get(stream.id) !== stream) return;
  app.dictation.streams.delete(stream.id);
  clearTimeout(stream.idle);
  stream.worker.kill();
  if (error !== undefined) app.emit('pi://dictation-stream', { id: stream.id, error });
}

function touch(app: App, stream: Stream): void {
  clearTimeout(stream.idle);
  stream.idle = setTimeout(() => close(app, stream, 'Dictation stopped because no audio arrived for 30 seconds'), IDLE_MS);
}

function owned(app: App, owner: string, id: string): Stream {
  const stream = app.dictation.streams.get(id);
  if (!stream || stream.owner !== owner) throw new Error('This dictation is no longer running');
  return stream;
}

/** Starts a live dictation. Text changes arrive as pi://dictation-stream events with this id. */
export function startStream(app: App, owner: string): { id: string } {
  const runtime = app.dictation;
  const engine = runtime.engine;
  if (!engine) throw new Error(runtime.error ? `Dictation is unavailable: ${runtime.error}` : 'Dictation is unavailable');
  if (runtime.streams.size > 0) throw new Error('Dictation is busy. Try again shortly.');
  const id = uniqueId(runtime.streams);
  const running = spawnWorker(engine, (committed, tentative) => {
    if (runtime.streams.get(id) === stream) app.emit('pi://dictation-stream', { id, committed, tentative });
  });
  const stream: Stream = { id, owner, worker: running, bytes: 0, finishing: false };
  runtime.streams.set(id, stream);
  running.done.catch(error => { if (!stream.finishing) close(app, stream, message(error)); });
  touch(app, stream);
  return { id };
}

export function feedStream(app: App, owner: string, id: string, audio: string): null {
  const stream = owned(app, owner, id);
  if (stream.finishing) throw new Error('This dictation is already finishing');
  if (audio.length > Math.ceil(MAX_FEED_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio) || audio.length % 4 !== 0) throw new Error('Invalid dictation audio');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length % 2 !== 0) throw new Error('Invalid dictation audio');
  if (stream.bytes + bytes.length > MAX_STREAM_BYTES) throw new Error('Dictation recording is too long');
  stream.bytes += bytes.length;
  stream.worker.write(bytes);
  touch(app, stream);
  return null;
}

export async function finishStream(app: App, owner: string, id: string): Promise<{ text: string }> {
  const stream = owned(app, owner, id);
  if (stream.finishing) throw new Error('This dictation is already finishing');
  stream.finishing = true;
  clearTimeout(stream.idle);
  stream.worker.end();
  try { return { text: await deadline(stream.worker, FINISH_MS, 'The speech engine did not finish in time') }; }
  finally { close(app, stream); }
}

export function cancelStream(app: App, owner: string, id: string): null {
  const stream = app.dictation.streams.get(id);
  if (stream && stream.owner === owner) close(app, stream);
  return null;
}
