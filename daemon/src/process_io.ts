import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { signalProcessGroup } from './process_cleanup';

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function desktopSessionsDir(home: string): string { return join(home, STORAGE_DIRECTORY, 'sessions'); }

export function ensureDesktopSessionsDir(home: string): string {
  const root = desktopSessionsDir(home);
  try { mkdirSync(root, { recursive: true }); } catch (error: any) { throw new Error(`Could not create piop session directory: ${error.message}`); }
  return root;
}

export interface ExitStatus { code: number | null; signal: NodeJS.Signals | null; success: boolean }

export interface CommandSpec {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  stdin?: 'ignore' | 'pipe';
  timeout?: number;
}

export interface Output { status: ExitStatus; stdout: Buffer; stderr: Buffer }

export function statusText(status: ExitStatus): string {
  if (status.code !== null) return `exit status: ${status.code}`;
  return `signal: ${status.signal}`;
}

function environment(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
  return merged;
}

export function spawnOptions(spec: CommandSpec, extra: SpawnOptions = {}): SpawnOptions {
  return { cwd: spec.cwd, env: environment(spec.env), ...extra };
}

export function runLimited(spec: CommandSpec, maxStdout: number, context: string): Promise<Output> {
  return collect(spec, maxStdout, 64 * 1024, context);
}

export function output(spec: CommandSpec): Promise<Output> {
  return collect(spec, Infinity, Infinity, spec.program);
}

function collect(spec: CommandSpec, maxStdout: number, maxStderr: number, context: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    const timeout = spec.timeout ?? 60_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) { reject(new Error(`${context}: invalid command timeout`)); return; }
    let child;
    try {
      child = spawn(spec.program, spec.args ?? [], spawnOptions(spec, { detached: true, stdio: [spec.input !== undefined || spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    } catch (error: any) { reject(new Error(`${context}: ${error.message}`)); return; }
    const stdout: Buffer[] = []; let stdoutLength = 0;
    const stderr: Buffer[] = []; let stderrLength = 0; let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL');
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      reject(error);
    };
    const errorTail = () => { const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-5).join('\n'); return tail ? `: ${tail}` : ''; };
    const timer = setTimeout(() => fail(new Error(`${context}: command ${spec.program} timed out after ${timeout} ms${errorTail()}`)), timeout);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutLength += chunk.length;
      if (stdoutLength > maxStdout) { fail(new Error(`${context}: output exceeded ${sizeText(maxStdout)}`)); return; }
      stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const remaining = maxStderr - stderrLength;
      if (settled || remaining <= 0) return;
      const kept = chunk.subarray(0, remaining); stderr.push(kept); stderrLength += kept.length;
    });
    child.on('error', error => fail(new Error(`${context}: ${error.message}${errorTail()}`)));
    child.stdin?.on('error', error => fail(new Error(`${context}: could not write command input: ${error.message}`)));
    child.stdout!.on('error', error => fail(new Error(`${context}: ${error.message}`)));
    child.stderr!.on('error', error => fail(new Error(`${context}: ${error.message}`)));
    if (spec.input !== undefined) child.stdin!.end(spec.input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ status: { code, signal, success: code === 0 }, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}
