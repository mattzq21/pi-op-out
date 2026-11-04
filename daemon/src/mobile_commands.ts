import { newChatBranches } from './chat_worktrees';
import { DEVELOPMENT } from './config';
import * as endpoint from './daemon_endpoint';
import { localHost } from './local_host';
import * as daemonRestart from './daemon_restart';
import * as peers from './peers';
import { clientBrokerRequest } from './broker';
import * as providerAuth from './provider_auth';
import * as terminalSessions from './terminal_sessions';
import * as projectFiles from './project_files';
import * as archives from './archives';
import * as sessionIndex from './session_index';
import * as sessionGroups from './session_groups';
import * as Registry from './session_registry';
import { profileRoot } from './host_operations';
import { refreshSkills } from './skill_discovery';
import { discoverPi } from './pi_discovery';
import { loadAppSettings, loadSettingsChange, saveAppSettings } from './settings';
import { buildPiCommand, launchSpec } from './pi_launch';
import { parseAppSettings, serializeAppSettings } from './settings_types';
import { serializeSession } from './types';
import { detachPiWith, ensureRuntimeOwner, openProjectDirectory, piCommand, piPresence, startPiForOwner, stopPi } from './pi_runtime';
import { closeTerminal, resizeTerminal, startTerminalForOwner, writeTerminal } from './terminals';
import type { App } from './app';
import { detachOwner } from './lifecycle';
import { isUsageProvider } from './provider_usage';

const RESTARTING = 'The daemon is restarting. Reconnect before retrying.';

type Kind = 'string' | 'string?' | 'number' | 'number?' | 'boolean' | 'boolean?' | 'strings' | 'strings?' | 'any';

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'object') return 'map';
  return typeof value + ' ' + JSON.stringify(value);
}

function argument(args: any, key: string, kind: Kind): any {
  const value = args?.[key];
  const optional = kind.endsWith('?');
  if (optional && (value === undefined || value === null)) return undefined;
  const base = optional ? kind.slice(0, -1) : kind;
  const fail = (expected: string): never => { throw new Error('Invalid ' + key + ': invalid type: ' + describe(value) + ', expected ' + expected); };
  switch (base) {
    case 'string': if (typeof value !== 'string') fail('a string'); return value;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail('a number'); return value;
    case 'boolean': if (typeof value !== 'boolean') fail('a boolean'); return value;
    case 'strings': if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('a sequence of strings'); return value;
    default: return value === undefined ? null : value;
  }
}

export async function dispatch(app: App, owner: string, command: string, args: any): Promise<any> {
  const finish = app.clients.beginRequest();
  try { return await dispatchRouted(app, owner, command, args); }
  finally {
    try { if (app.clients.closing()) await detachOwner(app, owner, false); } finally { finish(); }
  }
}

async function dispatchRouted(app: App, owner: string, command: string, args: any): Promise<any> {
  const release = await app.restart.gate.read();
  try {
    if ((await daemonRestart.blocking()) && command !== 'daemon_restart_status') throw new Error(RESTARTING);
    app.clients.ensureOpen();
    const routed = await peers.route(app, owner, command, args);
    if (routed !== undefined) return routed;
  } finally { release(); }
  return dispatchLocal(app, owner, command, args);
}

export async function dispatchPeer(app: App, owner: string, command: string, args: any): Promise<any> {
  const finish = app.clients.beginRequest();
  try { return await dispatchPeerRequest(app, owner, command, args); }
  finally {
    try { if (app.clients.closing()) await detachOwner(app, owner, false); } finally { finish(); }
  }
}

async function dispatchPeerRequest(app: App, owner: string, command: string, args: any): Promise<any> {
  if (typeof args?.hostId === 'string' && args.hostId !== 'local') throw new Error("Peer connections expose only this daemon's local host");
  if (command === 'save_app_settings' || command === 'change_session_groups' || command === 'load_session_groups') throw new Error('Configure this host through its own Piop settings');
  if (command === 'list_sessions') return peers.localSessions(app);
  if (command === 'storage_report') return { hosts: [await archives.inspectStorage(argument(args, 'archivesOnly', 'boolean?') === true)] };
  return dispatchLocal(app, owner, command, args);
}

async function dispatchLocal(app: App, owner: string, command: string, args: any): Promise<any> {
  app.clients.ensureOpen();
  if (DEVELOPMENT && command === 'debug_runtime') return endpoint.debugRuntime();
  if (command === 'daemon_restart_status') return daemonRestart.status(argument(args, 'restartId', 'string'));
  if (command === 'restart_daemon') {
    const release = await app.restart.gate.writeWithin(10_000, 'Pending daemon requests did not finish within 10 seconds. Try restarting again once they finish.');
    try { app.clients.ensureOpen(); return await daemonRestart.prepare(app, args); } finally { release(); }
  }
  let release: (() => void) | undefined;
  if (command === 'check_daemon_idle') {
    release = app.restart.gate.tryRead();
    if (!release) throw new Error('The remote daemon is preparing a restart');
  } else release = await app.restart.gate.read();
  try {
    if (await daemonRestart.blocking()) throw new Error(RESTARTING);
    return await dispatchCommand(app, owner, command, args);
  } finally { release(); }
}

async function dispatchCommand(app: App, owner: string, command: string, args: any): Promise<any> {
  app.clients.ensureOpen();
  const host = argument(args, 'hostId', 'string?');
  if (host !== undefined && host !== 'local') throw new Error('Requests for another host must go through the Piop daemon of that host');
  if (typeof args?.runtimeId === 'string') ensureRuntimeOwner(app.pi, args.runtimeId, owner);
  if (typeof args?.terminalId === 'string') app.terminals.ensureOwner(args.terminalId, owner);
  const handler = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) throw new Error('Command is not available on the daemon: ' + command);
  const result = await handler(app, owner, args);
  return result === undefined ? null : result;
}

type Handler = (app: App, owner: string, args: any) => Promise<any> | any;

async function loadSettings(app: App, args: any): Promise<any> {
  if (argument(args, 'refreshSkills', 'boolean?')) refreshSkills();
  if (argument(args, 'refreshTools', 'boolean?')) await discoverPi(app);
  return serializeAppSettings(await loadAppSettings(app));
}

async function saveHostSettings(app: App, args: any): Promise<any> {
  const settings = parseAppSettings(argument(args, 'settings', 'any'));
  const previous = await loadAppSettings(app);
  settings.keybindings = previous.keybindings;
  settings.debugMode = previous.debugMode;
  return saveAppSettings(app, settings);
}

function startPiOptions(args: any): any {
  if (!args || typeof args !== 'object') throw new Error('invalid type: ' + describe(args) + ', expected struct StartPiOptions');
  if (typeof args.runtimeId !== 'string') throw new Error('missing field ' + String.fromCharCode(96) + 'runtimeId' + String.fromCharCode(96));
  if (typeof args.clientId !== 'string') throw new Error('missing field ' + String.fromCharCode(96) + 'clientId' + String.fromCharCode(96));
  return args;
}

const COMMANDS: Record<string, Handler> = {
  check_daemon_idle: async app => { await daemonRestart.ensureLocalIdle(app); return null; },
  plugin_status: app => localHost(app).host.pluginStatus(),
  shared_terminal: (app, owner, args) => terminalSessions.shared(app, owner, args),
  broker_request: (app, _owner, args) => clientBrokerRequest(app, argument(args, 'path', 'string'), argument(args, 'body', 'any')),
  load_host_settings: (app, _owner, args) => loadSettings(app, args),
  load_host_settings_change: app => loadSettingsChange(app),
  save_host_settings: (app, _owner, args) => saveHostSettings(app, args),
  host_storage_report: async (_app, _owner, args) => ({ hosts: [await archives.inspectStorage(argument(args, 'archivesOnly', 'boolean?') === true, argument(args, 'archivesLimit', 'number?'))] }),
  submission_outcome: (app, _owner, args) => localHost(app).host.submissionOutcome(argument(args, 'submissionId', 'string')),
  provider_auth: (app, owner, args) => providerAuth.forOwner(app, owner, argument(args, 'request', 'any')),
  open_project_directory: async (_app, _owner, args) => { await openProjectDirectory(argument(args, 'cwd', 'string')); return null; },
  start_pi: async (app, owner, args) => {
    const result = await startPiForOwner(app, owner, app.pi, app.broker, startPiOptions(args));
    result.daemonId = endpoint.identity();
    return result;
  },
  stop_pi: (app, _owner, args) => {
    const id = argument(args, 'runtimeId', 'string');
    if (args.preserveRunning === true) return detachPiWith(app.pi, id, false, true);
    return stopPi(app.pi, id, argument(args, 'discardBlank', 'boolean?'));
  },
  pi_command: (app, _owner, args) => piCommand(app, app.pi, app.broker, argument(args, 'runtimeId', 'string'), argument(args, 'command', 'any')),
  pi_presence: async (app, _owner, args) => { await piPresence(app.pi, argument(args, 'runtimeId', 'string'), argument(args, 'presence', 'any')); return null; },
  start_terminal: async (app, owner, args) => {
    await startTerminalForOwner(app, owner, app.terminals, {
      terminalId: argument(args, 'terminalId', 'string'),
      sessionKey: argument(args, 'sessionKey', 'string'),
      cwd: argument(args, 'cwd', 'string'),
      cols: argument(args, 'cols', 'number'),
      rows: argument(args, 'rows', 'number'),
    });
    if (app.clients.closing()) {
      await closeTerminal(app.terminals, args.terminalId);
      app.clients.ensureOpen();
    }
    return null;
  },
  write_terminal: (app, _owner, args) => { writeTerminal(app.terminals, argument(args, 'terminalId', 'string'), argument(args, 'data', 'string')); return null; },
  resize_terminal: (app, _owner, args) => { resizeTerminal(app.terminals, argument(args, 'terminalId', 'string'), argument(args, 'cols', 'number'), argument(args, 'rows', 'number')); return null; },
  close_terminal: async (app, _owner, args) => { await closeTerminal(app.terminals, argument(args, 'terminalId', 'string')); return null; },
  list_sessions: async app => (await sessionIndex.listSessions(app, app.sessionIndex)).map(serializeSession),
  session_ids: () => Registry.ids(profileRoot()),
  load_session_groups: async (app, _owner, args) => {
    const seeds = argument(args, 'seeds', 'any');
    if (!Array.isArray(seeds)) throw new Error('Invalid seeds: invalid type: ' + describe(seeds) + ', expected a sequence');
    return sessionGroups.serializeGroups(await sessionGroups.loadSessionGroups(app, seeds.map(sessionGroups.parseSeed)));
  },
  change_session_groups: async (app, _owner, args) => sessionGroups.serializeGroups(await sessionGroups.changeSessionGroups(app, sessionGroups.parseChange(argument(args, 'change', 'any')))),
  home_directory: () => sessionIndex.homeDirectory(),
  create_temporary_chat: () => sessionIndex.createTemporaryChat(),
  remove_temporary_chat: async (_app, _owner, args) => { await sessionIndex.removeTemporaryChat(argument(args, 'path', 'string')); return null; },
  new_chat_branches: (_app, _owner, args) => newChatBranches(argument(args, 'path', 'string')),
  validate_project_directory: (_app, _owner, args) => sessionIndex.validateProjectDirectory(argument(args, 'path', 'string'), argument(args, 'allowStorage', 'boolean?'), argument(args, 'newChat', 'boolean?')),
  list_directories: (app, _owner, args) => sessionIndex.listDirectories(app, 'local', argument(args, 'path', 'string?')),
  read_image_file: (_app, _owner, args) => projectFiles.readImage(argument(args, 'cwd', 'string'), argument(args, 'path', 'string')),
  archive_session: async (app, owner, args) => {
    const terminalIds = (argument(args, 'terminalIds', 'strings') as string[]).filter(id => app.terminals.ownedByConnection(id, owner));
    await archives.archiveSession(app, app.terminals, argument(args, 'sessionPath', 'string'), terminalIds, argument(args, 'clientId', 'string'));
    return null;
  },
  delete_session: (app, _owner, args) => archives.deleteSession(app, app.pi, argument(args, 'sessionPath', 'string'), argument(args, 'clientId', 'string')),
  delete_archived_session: (app, _owner, args) => archives.deleteArchivedSession(app, app.pi, argument(args, 'sessionPath', 'string'), argument(args, 'sessionPaths', 'strings?'), argument(args, 'clientId', 'string')),
  restore_archived_session: async (app, _owner, args) => { await archives.restoreArchivedSession(app, argument(args, 'sessionPath', 'string'), argument(args, 'clientId', 'string')); return null; },
  relocate_session: async (app, _owner, args) => { await archives.relocateSession(app, argument(args, 'sessionPath', 'string'), argument(args, 'cwd', 'string'), argument(args, 'clientId', 'string')); return null; },
  recover_missing_session: (app, _owner, args) => archives.recoverMissingSession(app, argument(args, 'sessionPath', 'string'), argument(args, 'action', 'string'), argument(args, 'clientId', 'string')),
  load_app_settings: (app, _owner, args) => loadSettings(app, args),
  load_settings_change: app => loadSettingsChange(app),
  settings_pending_count: app => app.pi.settingsPendingSessions.size,
  save_app_settings: (app, _owner, args) => saveAppSettings(app, parseAppSettings(argument(args, 'settings', 'any'))),
  save_agent_definitions: (app, _owner, args) => localHost(app).host.saveAgents(argument(args, 'configuration', 'any'), argument(args, 'cwd', 'string?') || undefined),
  agent_prompt_preview: async (app, _owner, args) => {
    const settings = await loadAppSettings(app);
    const spec = launchSpec(buildPiCommand(settings, { kind: 'prompt-preview', cwd: argument(args, 'cwd', 'string?') ?? '~' }));
    return localHost(app).host.previewAgentPrompt(spec, argument(args, 'agent', 'string'));
  },
  move_agent: (app, _owner, args) => localHost(app).host.moveAgentDefinition(argument(args, 'agent', 'string'), argument(args, 'revision', 'string'), argument(args, 'from', 'string?') ?? null, argument(args, 'to', 'string?') ?? null),
  provider_usage: (app, _owner, args) => {
    const provider = argument(args, 'provider', 'string?');
    if (provider !== undefined && !isUsageProvider(provider)) throw new Error('Invalid provider: unknown usage provider ' + JSON.stringify(provider));
    return argument(args, 'refresh', 'boolean?') ? app.usage.refresh(app, provider) : app.usage.snapshot();
  },
};
