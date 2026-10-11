import { spawn } from 'node:child_process';
import { scriptLoader } from '../resources/host-script.cjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { remoteLoginCommand, ssh, type Host } from './host_connection';
import { shellQuote, spawnOptions, type CommandSpec } from './process_io';
import { descendantProcesses, killVerified } from './process_cleanup';
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
const DEFAULT_TIMEOUT = 2 * 60 * 1000;
const STORAGE_TIMEOUT = 10 * 60 * 1000;
const KILL_DELAY = 2000;

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
  const file = fileName(script.bundle);
  return hostCommand(host, `d=${scriptDirectory(host)}; [ -f "$d"/${file} ] || exit ${MISSING}; cd -- "$d" || exit 1; command exec 3< ./${file} || exit ${MISSING}; touch -c -- ${file} || exit 1; printf '%s' ${shellQuote(STARTED)} >&2; PIOP_STORAGE_DIRECTORY=${shellQuote(STORAGE_DIRECTORY)} exec ${bun} -e ${shellQuote(scriptLoader)} -- /proc/self/fd/3`);
}

/** Copies the script with a temporary file and a rename, then removes unused copies older than one day. */
function copyCommand(host: Host, script: HostScript<unknown, unknown>): CommandSpec {
  const directory = scriptDirectory(host);
  const keep = [...new Set(Object.values(HOST_SCRIPT_BUNDLES).map(fileName))].join('|');
  return hostCommand(host, `umask 077; d=${directory}; t=; mkdir -p "$d" && t=$(mktemp "$d/.copy.XXXXXX") && cat > "$t" && digest=$(sha256sum < "$t") && [ "${'$'}{digest%% *}" = ${fileName(script.bundle).slice(0, -4)} ] && mv -f "$t" "$d"/${fileName(script.bundle)} || { [ -z "$t" ] || rm -f -- "$t"; printf '%s\\n' 'Host script copy or checksum failed' >&2; exit 1; }; for f in "$d"/*.cjs; do case "${'$'}{f##*/}" in ${keep}) ;; *) find "$f" -mmin +1440 -exec rm -f -- {} + || printf '%s\\n' 'Host script cleanup failed' >&2 ;; esac; done`);
}

interface Run { code: number | null; started: boolean; stdout: Buffer; stderr: string }

function run(command: CommandSpec, input: string, maxOutput: number, signal: AbortSignal | undefined, timeout = DEFAULT_TIMEOUT): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HostScriptError('not-started', 'Host script was stopped before it started')); return; }
    let child;
    try { child = spawn(command.program, command.args ?? [], spawnOptions(command, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })); }
    catch (error: any) { reject(new HostScriptError('not-started', `Could not start host script: ${error?.message ?? error}`)); return; }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderr = '', pendingStderr = '';
    let started = false;
    const diagnostic = (text: string) => { stderr += text.slice(0, MAX_DIAGNOSTIC - stderr.length); };
    let failure: HostScriptError | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let descendants: ReturnType<typeof descendantProcesses> = [];
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      killTimer = undefined;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      child.removeListener('close', finish);
      child.removeListener('exit', onExit);
      if (failure) {
        killVerified(descendants);
        child.stdout!.destroy();
        child.stderr!.destroy();
      }
      child.stdout!.removeAllListeners('data');
      child.stderr!.removeAllListeners('data');
      diagnostic(pendingStderr);
      if (failure) { if (stderr.trim()) console.error(`Host script: ${stderr.trim()}`); reject(failure); return; }
      resolve({ code, started, stdout: Buffer.concat(stdout), stderr: stderr.trim() });
    };
    const onExit = (code: number | null) => { if (killTimer !== undefined) finish(code); };
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, signal); }
        catch (error: any) {
          if (error.code !== 'ESRCH') console.error(`Could not send ${signal} to host script process group: ${error?.message ?? error}`);
        }
      }
    };
    const stop = (error: HostScriptError) => {
      if (settled || killTimer !== undefined) return;
      failure ??= error;
      clearTimeout(deadline);
      if (child.exitCode !== null || child.signalCode !== null) { finish(child.exitCode); return; }
      if (child.pid !== undefined) descendants = descendantProcesses(child.pid);
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        killTimer = undefined;
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish(null);
      }, KILL_DELAY);
      child.stdin!.destroy();
    };
    const deadline = setTimeout(() => stop(new HostScriptError('unknown', `Host script timed out after ${timeout / 1000} seconds; its result is unknown (writes may or may not have completed)`)), timeout);
    const abort = () => stop(new HostScriptError('unknown', 'Host script was stopped; its outcome is unknown'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) { stop(new HostScriptError('unknown', 'Host script output exceeded its limit; its outcome is unknown')); return; }
      stdout.push(chunk);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      pendingStderr += chunk;
      let marker;
      while ((marker = pendingStderr.indexOf(STARTED)) !== -1) {
        started = true;
        diagnostic(pendingStderr.slice(0, marker));
        pendingStderr = pendingStderr.slice(marker + STARTED.length);
      }
      const length = Math.max(0, pendingStderr.length - STARTED.length + 1);
      diagnostic(pendingStderr.slice(0, length));
      pendingStderr = pendingStderr.slice(length);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
    child.once('error', error => { failure ??= new HostScriptError(child.pid === undefined ? 'not-started' : 'unknown', `Could not start host script: ${error.message}`); });
    child.once('close', finish);
    child.once('exit', onExit);
  });
}

async function copy(host: Host, script: HostScript<unknown, unknown>, signal: AbortSignal | undefined): Promise<void> {
  let result: Run;
  try { result = await run(copyCommand(host, script), script.bundle, 0, signal); }
  catch (error: any) { throw new HostScriptError('not-started', `Could not copy host script ${script.name}: ${error?.message ?? error}`); }
  if (result.code !== 0) throw new HostScriptError('not-started', `Could not copy host script ${script.name}: ${result.stderr || `exit code ${result.code}`}`);
  if (result.stderr) console.error(`Host script ${script.name} copy: ${result.stderr}`);
}

function reply<Result>(script: HostScript<unknown, Result>, result: Run): Result {
  const unknown = (reason: string) => new HostScriptError('unknown', `Host script ${script.name} ${reason}${result.stderr ? `: ${result.stderr}` : ''}`);
  if (!result.started) throw new HostScriptError(result.code === MISSING ? 'not-started' : 'unknown', `Host script ${script.name} start was not confirmed${result.stderr ? `: ${result.stderr}` : ` (exit code ${result.code})`}`);
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
  const timeout = ['storage-transaction', 'storage-inventory', 'index-sessions', 'session-descendants', 'session-registry', 'temporary-chat'].includes(script.name) ? STORAGE_TIMEOUT : DEFAULT_TIMEOUT;
  let result = await run(runCommand(host, script), input, script.maxOutput, options.signal, timeout);
  if (result.code === MISSING && !result.started) {
    await copy(host, script, options.signal);
    result = await run(runCommand(host, script), input, script.maxOutput, options.signal, timeout);
  }
  return reply(script, result);
}
