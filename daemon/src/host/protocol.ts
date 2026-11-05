import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { kind } from './json';
import { pluginRequest } from '../plugins';

export { kind, text, flag, array, messageText } from './json';

export interface LaunchSpec { program: string; args: string[]; env: Record<string, string>; cwd: string | null }

export interface SessionLaunch { key: string; spec: LaunchSpec; timeout: number; transient: boolean; clientId: string; cwd: string | null }

const launchSpecSchema = z.object({
  program: z.string(), args: z.array(z.string()),
  env: z.record(z.string(), z.string()).nullish().transform(env => env ?? {}), cwd: z.string().nullish().transform(cwd => cwd ?? null),
});

// The program, arguments, environment and folder that start Pi, as a client gives them.
export function parseLaunchSpec(value: unknown): LaunchSpec {
  const parsed = launchSpecSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid launch spec: ' + z.prettifyError(parsed.error));
  return parsed.data;
}

export function cloneSpec(spec: LaunchSpec): LaunchSpec { return { program: spec.program, args: [...spec.args], env: { ...spec.env }, cwd: spec.cwd }; }

export function serializeSpec(spec: LaunchSpec): any {
  const env: Record<string, string> = {};
  for (const key of Object.keys(spec.env).sort()) env[key] = spec.env[key]!;
  return { program: spec.program, args: spec.args, env, cwd: spec.cwd };
}

export function argument(spec: LaunchSpec, flagName: string): string | undefined {
  const index = spec.args.lastIndexOf(flagName);
  return index >= 0 ? spec.args[index + 1] : undefined;
}

export function sessionSpec(spec: LaunchSpec, flagName: string, value: string): LaunchSpec {
  const next = cloneSpec(spec);
  next.args = [];
  for (let index = 0; index < spec.args.length; index++) {
    const arg = spec.args[index]!;
    if (arg === '--session' || arg === '--session-id' || arg === '--fork') index++;
    else next.args.push(arg);
  }
  next.args.push(flagName, value);
  return next;
}

export function prepareSpec(spec: LaunchSpec, key: string, client: string, home: string): void {
  spec.env.PIOP_CONVERSATION_CLIENT = client;
  if (argument(spec, '--session') === undefined && argument(spec, '--session-id') === undefined) spec.args.push('--session-id', key);
}

export function readHeaderLine(path: string, limit = 64 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(fd, buffer, length, limit - length, null);
      if (count === 0) break;
      const newline = buffer.subarray(length, length + count).indexOf(10);
      length += count;
      if (newline >= 0) { length = length - count + newline + 1; break; }
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

export function specIdentity(spec: LaunchSpec, fallback: string): string {
  const path = argument(spec, '--session');
  if (path === undefined) return argument(spec, '--session-id') ?? fallback;
  let header: string;
  try { header = readHeaderLine(path); } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error('This conversation has been deleted or archived');
    throw new Error(error?.message ?? String(error));
  }
  const parsed = JSON.parse(header);
  const id = parsed?.id;
  if (typeof id !== 'string' || !id) throw new Error('Missing session identity');
  return id;
}

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean { return UUID.test(value.replace(/^urn:uuid:/, '').replace(/^\{(.*)\}$/, '$1')); }

export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function controlAction(command: string): string | undefined {
  switch (command) {
    case 'abort': return 'stop';
    case 'cancel_preparation': return 'cancel-preparation';
    default: return undefined;
  }
}

const APP_REQUESTS = new Set(['queue_prompt', 'insert_context', 'orchestration_message', 'provider_auth_refresh', 'context_cap_settings',
  'rewind_message', 'fork_after', 'copy_after', 'prepare_fork', 'select_agent', 'chat_agent', 'set_chat_agent',
  'set_fast_mode', 'conversation_client', 'retry_response', 'resume_interrupted', 'queue_hold', 'queue_offer', 'prompt_preview']);

export function wireCommand(command: any, id: string): any {
  const name = kind(command);
  const action = controlAction(name);
  const appRequest = APP_REQUESTS.has(name) || pluginRequest(name) ? name : undefined;
  const wire = { ...(command && typeof command === 'object' && !Array.isArray(command) ? command : {}), id };
  if (action !== undefined || appRequest !== undefined) {
    const payload = action !== undefined ? { id, action } : wire;
    return { type: 'piop_request', id, command: appRequest ?? 'control', payload };
  }
  return wire;
}
