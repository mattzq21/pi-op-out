import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';

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

/** Runs a command and keeps at most maxStdout bytes of output and 64 KiB of errors. */
export function runLimited(spec: CommandSpec, maxStdout: number, context: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.program, spec.args ?? [], spawnOptions(spec, { stdio: [spec.input !== undefined || spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    } catch (error: any) { reject(new Error(`${context}: ${error.message}`)); return; }
    const stdout: Buffer[] = []; let stdoutLength = 0; let oversized = false;
    const stderr: Buffer[] = []; let stderrLength = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      if (oversized) return;
      stdout.push(chunk); stdoutLength += chunk.length;
      if (stdoutLength > maxStdout) { oversized = true; child.kill('SIGKILL'); }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrLength;
      if (remaining <= 0) return;
      const kept = chunk.subarray(0, remaining); stderr.push(kept); stderrLength += kept.length;
    });
    child.on('error', error => reject(new Error(`${context}: ${error.message}`)));
    if (spec.input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(spec.input); }
    child.on('close', (code, signal) => {
      if (oversized) { reject(new Error(`${context}: output exceeded ${Math.floor(maxStdout / 1024 / 1024)} MiB`)); return; }
      resolve({ status: { code, signal, success: code === 0 }, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

/** Runs a command and collects all output. */
export function output(spec: CommandSpec): Promise<Output> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.program, spec.args ?? [], spawnOptions(spec, { stdio: [spec.input !== undefined || spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    } catch (error) { reject(error); return; }
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    if (spec.input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(spec.input); }
    child.on('close', (code, signal) => resolve({ status: { code, signal, success: code === 0 }, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}
