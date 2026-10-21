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
import { brokerEnvironment } from './broker';
import { requireLocal } from './host_connection';

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

export async function sessionIdentity(_settings: AppSettings, hostId: string, path: string): Promise<string> {
  requireLocal(hostId);
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
  const database = Registry.open(root);
  try {
    const row = database.prepare('SELECT session_id FROM sessions WHERE session_path=?').get(path) as { session_id: string | null } | undefined;
    const id = row?.session_id ?? undefined;
    const canonicalRoot = realpathSync(root);
    if (!id && [root, canonicalRoot].some(directory => ['sessions', 'archived'].some(area => startsWithPath(path, join(directory, area))))) {
      throw new Error('Session path is not registered');
    }
    if (id) return id;
    return localExternalIdentity(database, path);
  } finally { database.close(); }
}

function localExternalIdentity(database: ReturnType<typeof Registry.open>, path: string): string | undefined {
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

export type PiLaunch = { kind: 'rpc'; cwd?: string | null; sessionPath?: string | null; sessionId?: string | null; forkPath?: string | null };

export function buildPiCommand(broker: BrokerRuntime, settings: AppSettings, hostId: string, launch: PiLaunch, _daemonPort?: number): LaunchCommand {
  if (hostId !== 'local') throw new Error('Remote Pi must be launched by its owning daemon');
  const [brokerPort, brokerToken] = brokerEnvironment(broker);
  return localPiCommand(settings, hostId, launch, brokerPort, brokerToken, homeDir());
}

function localWorkerCommand(piPath: string): LaunchCommand {
  const command = sessionWorkerCommand(piPath);
  command.env.PIOP_STORAGE_DIRECTORY = STORAGE_DIRECTORY;
  command.env.PI_CODING_AGENT_DIR = join(homeDir(), STORAGE_DIRECTORY);
  command.args.push('--mode', 'rpc');
  return command;
}

function localPiCommand(settings: AppSettings, hostId: string, launch: PiLaunch, brokerPort: number, brokerToken: string, desktopHome: string): LaunchCommand {
  const piPath = piExecutable();
  const sessionDir = ensureDesktopSessionsDir(desktopHome);
  const command = localWorkerCommand(piPath);
  configureLocalExtensions(command, settings, hostId, brokerPort, brokerToken, sessionDir);
  command.env.PIOP_RPC_ENTRY = join(Ext.generatedExtensionRoot(), 'runtime-bridge.cjs');
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
  if (launch.forkPath) {
    if (!launch.sessionId) throw new Error('Fork requires a reserved session identity');
    command.args.push('--fork', launch.forkPath, '--session-id', launch.sessionId);
  }
  else if (launch.sessionPath) command.args.push('--session', launch.sessionPath);
  else if (launch.sessionId) command.args.push('--session-id', launch.sessionId);
}

function configureLocalExtensions(command: LaunchCommand, settings: AppSettings, hostId: string, brokerPort: number, brokerToken: string, sessionDir: string): void {
  const root = Ext.generatedExtensionRoot();
  Ext.prepareRuntimeBridge();
  command.env.PIOP_AGENT_RESOURCES = JSON.stringify(Ext.agentResources(settings));
  command.env.PIOP_AGENT_CONFIG_PATH = join(homeDir(), STORAGE_DIRECTORY, 'piop-define-agents/config.json');
  command.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = join(root, 'context-cap-settings.json');
  command.env.PIOP_GENERATED_EXTENSION_ROOT = root;
  const mcpExtension = Ext.prepareMcpBridge();
  const contextWindowCapExtension = Ext.prepareContextWindowCapExtension(settings);
  const contextBarExtension = Ext.prepareContextBarExtension();
  const openaiCacheForkExtension = Ext.prepareOpenaiCacheForkExtension();
  const codexWebSearchExtension = Ext.prepareCodexWebSearchExtension();
  const definedAgentsExtension = Ext.prepareDefinedAgentsExtension();
  const session = Ext.prepareSessionExtensions();
  const plugins = Ext.preparePluginExtensions();
  const after = (core: Contributions.CoreExtension) => plugins.filter(plugin => plugin.after === core).flatMap(plugin => ['--extension', plugin.path]);
  command.args.push('--extension', 'builtin:codemode', '--extension', 'builtin:tool-search');
  command.args.push('--session-dir', sessionDir, '--approve', '--no-skills',
    '--extension', Ext.prepareProvidersRefreshExtension(), '--extension', mcpExtension, '--extension', session.storage, '--extension', session.hooks, '--extension', session.controls, '--extension', session.broker,
    '--extension', session.goals, ...after('goals'),
    '--extension', contextWindowCapExtension, '--extension', contextBarExtension, ...after('context-bar'),
    '--extension', Ext.prepareFastModeExtension(), '--extension', openaiCacheForkExtension, '--extension', codexWebSearchExtension,
    '--extension', definedAgentsExtension);
  Object.assign(command.env, {
    PI_DESKTOP_DEFINED_AGENTS_EXTENSION: definedAgentsExtension,
    PIOP_MCP_EXTENSION: mcpExtension,
    PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION: codexWebSearchExtension,
    PI_DESKTOP_CONTEXT_WINDOW_CAP_EXTENSION: contextWindowCapExtension,
    PIOP_COMMAND_POLICY: JSON.stringify(Contributions.commandPolicy()),
    PI_DESKTOP_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    PI_DESKTOP_BROKER_TOKEN: brokerToken,
    PI_DESKTOP_HOST_ID: hostId,
  });
}

export function localLaunchDirectory(cwd: string | undefined): string {
  if (cwd === '~') return homeDir();
  if (cwd !== undefined) return cwd;
  return process.cwd();
}
