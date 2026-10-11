import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { remoteLoginCommand, ssh, type Host } from './host_connection';
import { shellQuote, spawnOptions, type CommandSpec } from './process_io';
import { HOST_SCRIPT_BUNDLES, type HostScriptName } from './resources';

/** A piop script that runs on a Host to read or change its stored data. read checks the result shape. */
export interface HostScript<Request, Result> {
  name: HostScriptName;
  bundle: string;
  maxOutput: number;
  read(value: unknown): Result;
  /** Only used to type the request. */
  readonly request?: Request;
}

export function hostScript<Request, Result>(name: HostScriptName, maxOutput: number, read: (value: unknown) => Result): HostScript<Request, Result> {
  return { name, bundle: HOST_SCRIPT_BUNDLES[name], maxOutput, read };
}

/**
 * not-started: no script code ran, so nothing changed.
 * failed: the script reported its own error.
 * unknown: the script started but its outcome is not known.
 */
export type HostScriptFailure = 'not-started' | 'failed' | 'unknown';

export class HostScriptError extends Error {
  constructor(
    public readonly kind: HostScriptFailure,
    message: string,
    /** Set by storage transactions that failed: rolled-back or pending. */
    public readonly state?: string,
    public readonly warning?: string,
  ) {
    super(message);
    this.name = 'HostScriptError';
  }
}

const MISSING = 97;
const STARTED = 'piop-host-script-started\n';
const MAX_DIAGNOSTIC = 64 * 1024;

const fileName = (bundle: string) => createHash('sha256').update(bundle).digest('hex') + '.cjs';

function scriptDirectory(host: Host): string {
  return host.kind === 'local' ? shellQuote(join(homeDir(), STORAGE_DIRECTORY, 'host-scripts')) : `"$HOME"/${shellQuote(STORAGE_DIRECTORY)}/host-scripts`;
}

function hostCommand(host: Host, shell: string): CommandSpec {
  if (host.kind === 'remote') return ssh(host.host, remoteLoginCommand(shell));
  return { program: 'sh', args: ['-c', shell], env: { BUN_BE_BUN: '1' } };
}

/** Runs the copied file if it exists. Exits with MISSING before any script code runs if it does not. */
function runCommand(host: Host, script: HostScript<unknown, unknown>): CommandSpec {
  const bun = host.kind === 'local' ? shellQuote(process.execPath) : 'bun';
  const file = `${scriptDirectory(host)}/${fileName(script.bundle)}`;
  return hostCommand(host, `f=${file}; [ -f "$f" ] || exit ${MISSING}; printf '%s' ${shellQuote(STARTED)} >&2; PIOP_STORAGE_DIRECTORY=${shellQuote(STORAGE_DIRECTORY)} exec ${bun} "$f"`);
}

/** Copies the script with a temporary file and a rename, then removes copies of scripts that this daemon does not have. */
function copyCommand(host: Host, script: HostScript<unknown, unknown>): CommandSpec {
  const directory = scriptDirectory(host);
  const keep = [...new Set(Object.values(HOST_SCRIPT_BUNDLES).map(fileName))].join('|');
  return hostCommand(host, `umask 077; d=${directory}; mkdir -p "$d" && t=$(mktemp "$d/.copy.XXXXXX") && cat > "$t" && mv -f "$t" "$d"/${fileName(script.bundle)} || exit 1; for f in "$d"/*.cjs; do case "${'$'}{f##*/}" in ${keep}) ;; *) rm -f -- "$f" ;; esac; done`);
}

interface Run { code: number | null; started: boolean; stdout: Buffer; stderr: string }

function run(command: CommandSpec, input: string, maxOutput: number, signal: AbortSignal | undefined): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HostScriptError('not-started', 'Host script was stopped before it started')); return; }
    let child;
    try { child = spawn(command.program, command.args ?? [], spawnOptions(command, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })); }
    catch (error: any) { reject(new HostScriptError('not-started', `Could not start host script: ${error?.message ?? error}`)); return; }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderr = '';
    let failure: HostScriptError | undefined;
    const stop = (error: HostScriptError) => {
      failure ??= error;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error: any) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const abort = () => stop(new HostScriptError('unknown', 'Host script was stopped; its outcome is unknown'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) { stop(new HostScriptError('unknown', 'Host script output exceeded its limit; its outcome is unknown')); return; }
      stdout.push(chunk);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < MAX_DIAGNOSTIC) stderr += chunk.slice(0, MAX_DIAGNOSTIC - stderr.length); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
    child.on('error', error => { failure ??= new HostScriptError('not-started', `Could not start host script: ${error.message}`); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      const started = stderr.startsWith(STARTED);
      if (started) stderr = stderr.slice(STARTED.length);
      if (failure) { reject(failure.kind === 'unknown' && !started ? new HostScriptError('not-started', failure.message) : failure); return; }
      resolve({ code, started, stdout: Buffer.concat(stdout), stderr: stderr.trim() });
    });
  });
}

async function copy(host: Host, script: HostScript<unknown, unknown>, signal: AbortSignal | undefined): Promise<void> {
  const result = await run(copyCommand(host, script), script.bundle, 0, signal);
  if (result.code !== 0) throw new HostScriptError('not-started', `Could not copy host script ${script.name}: ${result.stderr || `exit code ${result.code}`}`);
}

function reply<Result>(script: HostScript<unknown, Result>, result: Run): Result {
  const unknown = (reason: string) => new HostScriptError('unknown', `Host script ${script.name} ${reason}${result.stderr ? `: ${result.stderr}` : ''}`);
  if (!result.started) throw new HostScriptError('not-started', `Host script ${script.name} did not start${result.stderr ? `: ${result.stderr}` : ` (exit code ${result.code})`}`);
  let value: any;
  try { value = JSON.parse(result.stdout.toString('utf8')); } catch { throw unknown('gave no valid reply'); }
  if (result.stderr) console.error(`Host script ${script.name}: ${result.stderr}`);
  if (value?.ok === false && typeof value.error === 'string' && result.code !== 0) {
    throw new HostScriptError('failed', value.error, typeof value.state === 'string' ? value.state : undefined, typeof value.warning === 'string' ? value.warning : undefined);
  }
  if (value?.ok !== true || !('result' in value) || result.code !== 0) throw unknown('gave an invalid reply');
  try { return script.read(value.result); }
  catch (error: any) { throw unknown(`gave an invalid result (${error?.message ?? error})`); }
}

/** Runs the script on the host with the request as JSON on stdin. Copies the script to the host first when it is missing there. */
export async function runHostScript<Request, Result>(host: Host, script: HostScript<Request, Result>, request: Request, options: { signal?: AbortSignal } = {}): Promise<Result> {
  const input = JSON.stringify(request);
  let result = await run(runCommand(host, script), input, script.maxOutput, options.signal);
  if (result.code === MISSING && !result.started) {
    await copy(host, script, options.signal);
    result = await run(runCommand(host, script), input, script.maxOutput, options.signal);
  }
  return reply(script, result);
}
