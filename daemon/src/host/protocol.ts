import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { kind } from './json';
import { pluginRequest } from '../plugin_contributions';

export { kind, text, flag, array, messageText } from './json';

export interface LaunchSpec { program: string; args: string[]; env: Record<string, string>; cwd: string | null }

export interface SessionLaunch { key: string; spec: LaunchSpec; timeout: number; transient: boolean; clientId: string; cwd: string | null }

export function parseLaunchSpec(value: any): LaunchSpec {
  if (!value || typeof value !== 'object') throw new Error('invalid type: expected struct LaunchSpec');
  if (typeof value.program !== 'string') throw new Error('missing field ' + '\x60program\x60');
  if (!Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== 'string')) throw new Error('missing field ' + '\x60args\x60');
  const env: Record<string, string> = {};
  if (value.env !== undefined && value.env !== null) {
    if (typeof value.env !== 'object') throw new Error('invalid type: expected a map');
    for (const [key, item] of Object.entries(value.env)) { if (typeof item !== 'string') throw new Error('invalid type: expected a string'); env[key] = item; }
  }
  if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') throw new Error('invalid type: expected a string');
  return { program: value.program, args: [...value.args], env, cwd: value.cwd ?? null };
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
  if (spec.env.PIOP_SESSION_CWD !== undefined) spec.env.PIOP_SESSION_CWD = expandHome(spec.env.PIOP_SESSION_CWD, home);
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
    case 'pause': return 'pause';
    case 'resume': return 'resume';
    case 'abort': return 'stop';
    case 'cancel_preparation': return 'cancel-preparation';
    case 'get_pause_state': return 'state';
    default: return undefined;
  }
}

const APP_REQUESTS = new Set(['queue_prompt', 'prepare_goal_prompt', 'get_goal_preparation', 'orchestration_message', 'provider_auth_refresh', 'context_cap_settings',
  'fork_and_forget', 'fork_after', 'copy_after', 'prepare_fork', 'select_agent', 'configure_agents', 'get_agent_configuration',
  'set_fast_mode', 'conversation_client']);

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
