import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir, nodeExecutable, pathWithNode } from '../environment';
import { installedPi } from '../pi_install';
import * as Ext from '../extensions';
import * as Contributions from '../plugins';
import { ensureDesktopSessionsDir, shellQuote } from '../process';
import { validateRemoteHost, type AppSettings } from '../settings_types';
import * as SessionTables from '../../resources/session-database.ts';
import type { BrokerRuntime } from '../broker';
import { QUEUE_TOOLS } from '../host/goals/commands';

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

function readFirstLine(path: string, limit = 64 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY);
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

function transcriptSessionIdentity(path: string): string {
  const id = JSON.parse(readFirstLine(path))?.id;
  if (typeof id !== 'string' || !id) throw new Error('Missing session identity');
  return id;
}

function startsWithPath(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }

export function localRegisteredIdentity(path: string): string | undefined {
  const root = join(homeDir(), STORAGE_DIRECTORY);
  const id = SessionTables.sessionIdByPath(root, path);
  const canonicalRoot = realpathSync(root);
  if (!id && [root, canonicalRoot].some(directory => startsWithPath(path, join(directory, 'sessions')))) {
    throw new Error('Session path is not registered');
  }
  return id;
}

export type PiLaunch = { kind: 'rpc'; cwd?: string | null; sessionPath?: string | null; sessionId?: string | null; forkPath?: string | null } | { kind: 'prompt-preview'; cwd: string };

export async function buildPiCommand(settings: AppSettings, launch: PiLaunch): Promise<LaunchCommand> {
  return localPiCommand(settings, launch, homeDir(), (await installedPi()).cli);
}

function localWorkerCommand(piPath: string, launch: PiLaunch, bridge: string): LaunchCommand {
  const command: LaunchCommand = { program: nodeExecutable(), args: [bridge, piPath], env: launch.kind === 'prompt-preview' ? { PIOP_PROMPT_PREVIEW: '1' } : {} };
  command.env.PIOP_STORAGE_DIRECTORY = STORAGE_DIRECTORY;
  command.env.PI_CODING_AGENT_DIR = join(homeDir(), STORAGE_DIRECTORY);
  command.args.push('--mode', 'rpc');
  return command;
}

function localPiCommand(settings: AppSettings, launch: PiLaunch, desktopHome: string, piPath: string): LaunchCommand {
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
  command.env.PIOP_CONTEXT_CAP_SETTINGS = JSON.stringify(Ext.contextCapSettings(settings));
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
