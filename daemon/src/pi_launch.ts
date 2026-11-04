import { supportedPi } from '../resources/pi-runtime.cjs';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir, nodeExecutable, pathWithNode, piExecutable } from './environment';
import * as Ext from './extensions';
import * as Contributions from './plugin_contributions';
import { ensureDesktopSessionsDir, shellQuote } from './process_io';
import * as Registry from './session_registry';
import { validateRemoteHost, type AppSettings } from './settings_types';
import { transaction } from './util/db';
import { sessionWorkerCommand } from './session_worker';
import type { BrokerRuntime } from './broker';
import { QUEUE_TOOLS } from './host/goals/commands';

export { validateRemoteHost };
export { remoteHost, remoteLoginCommand, ssh, sshBase, userSshConfig } from './host_connection';

export interface LaunchCommand {
  program: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export function launchSpec(command: LaunchCommand): any {
  return { program: command.program, args: command.args, cwd: command.cwd ?? null, env: command.env };
}

export function remotePiPath(path: string): string {
  if (path === 'pi') return '"$(bash -lc \'command -v pi\')"';
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : shellQuote(path);
}

export function remoteDirectoryPath(path: string | undefined | null): string {
  const trimmed = path?.trim();
  if (!trimmed || trimmed === '~') return '"$HOME"';
  if (trimmed.startsWith('~/')) return `$HOME/${shellQuote(trimmed.slice(2))}`;
  return shellQuote(trimmed);
}

export async function sessionIdentity(path: string): Promise<string> {
  const registered = localRegisteredIdentity(path);
  if (registered) return registered;
  return transcriptSessionIdentity(path);
}

export function readFirstLine(path: string, limit = 64 * 1024, nonblocking = false): string {
  const fd = openSync(path, constants.O_RDONLY | (nonblocking ? constants.O_NONBLOCK : 0));
  try {
    if (nonblocking && !fstatSync(fd).isFile()) throw new Error('Session transcript is not a regular file');
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

function transcriptSessionIdentity(path: string): string {
  const id = JSON.parse(readFirstLine(path))?.id;
  if (typeof id !== 'string' || !id) throw new Error('Missing session identity');
  return id;
}

function startsWithPath(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }

export function localRegisteredIdentity(path: string): string | undefined {
  const root = join(homeDir(), STORAGE_DIRECTORY);
  const database = Registry.connection(root);
  const row = database.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(path) as { session_id: string | null } | undefined;
  const id = row?.session_id ?? undefined;
  const canonicalRoot = realpathSync(root);
  if (!id && [root, canonicalRoot].some(directory => ['sessions', 'archived'].some(area => startsWithPath(path, join(directory, area))))) {
    throw new Error('Session path is not registered');
  }
  if (id) return id;
  return localExternalIdentity(database, path);
}

function localExternalIdentity(database: ReturnType<typeof Registry.connection>, path: string): string | undefined {
  return transaction(database, 'IMMEDIATE', () => {
    const key = createHash('sha256').update(path).digest('hex');
    const row = database.prepare("SELECT json_extract(record_json, '$.sessionId') AS id FROM external_transcripts WHERE record_id=? AND json_extract(record_json, '$.path')=?").get(key, path) as { id: string | null } | undefined;
    if (!row) return undefined;
    if (row.id === null) {
      const id = importExternalIdentity(path);
      database.prepare("UPDATE external_transcripts SET record_json=json_set(record_json, '$.sessionId', ?) WHERE record_id=?").run(id, key);
      return id;
    }
    return row.id;
  });
}

function importExternalIdentity(path: string): string {
  const header = JSON.parse(readFirstLine(path, 64 * 1024, true));
  if (header?.type !== 'session') throw new Error('Invalid session header');
  if (typeof header.id !== 'string' || !header.id) throw new Error('Missing session identity');
  return header.id;
}

export type PiLaunch = { kind: 'rpc'; cwd?: string | null; sessionPath?: string | null; sessionId?: string | null; forkPath?: string | null } | { kind: 'prompt-preview'; cwd: string };

export function buildPiCommand(settings: AppSettings, launch: PiLaunch): LaunchCommand {
  return localPiCommand(settings, launch, homeDir());
}

function localWorkerCommand(piPath: string, launch: PiLaunch, bridge: string): LaunchCommand {
  const command: LaunchCommand = launch.kind === 'prompt-preview'
    ? { program: nodeExecutable(), args: [bridge, piPath], env: { PIOP_PROMPT_PREVIEW: '1' } }
    : sessionWorkerCommand(piPath);
  command.env.PIOP_STORAGE_DIRECTORY = STORAGE_DIRECTORY;
  command.env.PI_CODING_AGENT_DIR = join(homeDir(), STORAGE_DIRECTORY);
  command.args.push('--mode', 'rpc');
  return command;
}

function localPiCommand(settings: AppSettings, launch: PiLaunch, desktopHome: string): LaunchCommand {
  const piPath = piExecutable();
  supportedPi(piPath);
  const generated = Ext.generatedExtensions();
  const sessionDir = ensureDesktopSessionsDir(desktopHome);
  const command = localWorkerCommand(piPath, launch, generated.bridge);
  configureLocalExtensions(command, settings, sessionDir, generated);
  command.env.PIOP_RPC_ENTRY = generated.bridge;
  command.env.JITI_NATIVE_MODULES = '["typebox"]';
  command.env.NODE_COMPILE_CACHE = join(homeDir(), STORAGE_DIRECTORY, 'node-compile-cache');
  const node = nodeExecutable();
  command.env.PIOP_NODE = node;
  const path = pathWithNode(node);
  if (path !== undefined) command.env.PATH = path;
  configureLocalLaunch(command, launch, piPath);
  if (settings.defaultThinking.trim()) command.args.push('--thinking', settings.defaultThinking.trim());
  return command;
}

function configureLocalLaunch(command: LaunchCommand, launch: PiLaunch, piPath: string): void {
  command.cwd = localLaunchDirectory(launch.cwd ?? undefined);
  command.env.PI_DESKTOP_PI_EXECUTABLE = piPath;
  if (launch.kind === 'prompt-preview') command.args.push('--no-session');
  else if (launch.forkPath) {
    if (!launch.sessionId) throw new Error('Fork requires a reserved session identity');
    command.args.push('--fork', launch.forkPath, '--session-id', launch.sessionId);
  }
  else if (launch.sessionPath) command.args.push('--session', launch.sessionPath);
  else if (launch.sessionId) command.args.push('--session-id', launch.sessionId);
}

function configureLocalExtensions(command: LaunchCommand, settings: AppSettings, sessionDir: string, generated: Ext.GeneratedExtensions): void {
  const core = generated.core;
  command.env.PIOP_AGENT_RESOURCES = JSON.stringify({ ...Ext.agentResources(settings), pluginAgentTools: Contributions.agentTools() });
  command.env.PIOP_STORAGE_ROOT = join(homeDir(), STORAGE_DIRECTORY);
  command.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = Ext.contextCapSettingsPath();
  const after = (position: Contributions.CoreExtension) => generated.plugins.filter(plugin => plugin.after === position).flatMap(plugin => ['--extension', plugin.path]);
  command.args.push('--extension', 'builtin:codemode', '--extension', 'builtin:tool-search');
  command.args.push('--session-dir', sessionDir, '--approve', '--no-skills',
    '--extension', core.ocx, '--extension', core.providersRefresh, '--extension', core.mcp, '--extension', core.storage, '--extension', core.hooks, '--extension', core.controls, '--extension', core.broker, '--extension', core.compactionTiming, ...after('session'),
    '--extension', core.contextWindowCap, '--extension', core.contextBar, ...after('context-bar'),
    '--extension', core.fastMode, '--extension', core.openaiCacheFork,
    '--extension', core.definedAgents, '--extension', core.skills);
  Object.assign(command.env, {
    PI_DESKTOP_DEFINED_AGENTS_EXTENSION: core.definedAgents,
    PIOP_MCP_EXTENSION: core.mcp,
    PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION: core.contextWindowCap,
    PIOP_COMMAND_POLICY: JSON.stringify(Contributions.commandPolicy()),
    PIOP_QUEUE_TOOLS: JSON.stringify(QUEUE_TOOLS),
  });
}

export function localLaunchDirectory(cwd: string | undefined): string {
  if (cwd === '~') return homeDir();
  if (cwd !== undefined) return cwd;
  return process.cwd();
}
