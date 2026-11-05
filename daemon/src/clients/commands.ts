import { newChatBranches } from '../worktrees';
import { DEVELOPMENT } from '../config';
import * as endpoint from '../service';
import { localHost } from '../local_host';
import * as daemonRestart from '../restart';
import * as peers from '../peers';
import { clientBrokerRequest } from '../broker';
import * as providerAuth from '../providers';
import * as terminalSessions from '../terminals';
import * as projectFiles from '../projects';
import * as archives from '../archives';
import * as sessionIndex from '../sessions';
import * as sessionGroups from '../sessions';
import * as Registry from '../session_registry';
import { profileRoot } from '../host_operations';
import { refreshSkills } from '../inventories';
import { discoverPi, buildPiCommand, launchSpec, detachPiWith, ensureRuntimeOwner, openProjectDirectory, piCommand, piPresence, startPiForOwner, stopPi } from '../pi';
import { loadAppSettings, loadSettingsChange, saveAppSettings } from '../settings';
import { completeSettings, serializeAppSettings, type AppSettings } from '../settings_types';
import { commandArgs, isCommand, localCommand, type CommandArgs, type CommandName } from '../../../protocol/commands';
import { serializeSession } from '../types';
import { closeTerminal, resizeTerminal, startTerminalForOwner, writeTerminal } from '../terminals';
import type { App } from '../app';
import { detachOwner } from '../lifecycle';
import { isUsageProvider } from '../providers';

const RESTARTING = 'The daemon is restarting. Reconnect before retrying.';

// The command name and its checked arguments.
function checked(command: string, args: unknown): [CommandName, any] {
  if (!isCommand(command)) throw new Error('Command is not available on the daemon: ' + command);
  return [command, commandArgs(command, args)];
}

export async function dispatch(app: App, owner: string, command: string, args: any): Promise<any> {
  const finish = app.clients.beginRequest();
  try { return await dispatchRouted(app, owner, ...checked(command, args)); }
  finally {
    try { if (app.clients.closing()) await detachOwner(app, owner, false); } finally { finish(); }
  }
}

async function dispatchRouted(app: App, owner: string, command: CommandName, args: any): Promise<any> {
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
  try { return await dispatchPeerRequest(app, owner, ...checked(command, args)); }
  finally {
    try { if (app.clients.closing()) await detachOwner(app, owner, false); } finally { finish(); }
  }
}

// A command that another daemon sends on for one of its clients.
async function dispatchPeerRequest(app: App, owner: string, command: CommandName, args: any): Promise<any> {
  if (args.hostId !== undefined && args.hostId !== 'local') throw new Error("Peer connections expose only this daemon's local host");
  if (localCommand(command)) throw new Error('Only clients of this daemon can use ' + command);
  if (command === 'list_sessions') return peers.localSessions(app);
  if (command === 'storage_report') return { hosts: [await archives.inspectStorage(args.archivesOnly === true)] };
  return dispatchLocal(app, owner, command, args);
}

async function dispatchLocal(app: App, owner: string, command: CommandName, args: any): Promise<any> {
  app.clients.ensureOpen();
  if (command === 'debug_runtime') {
    if (!DEVELOPMENT) throw new Error('Command is not available on the daemon: ' + command);
    return endpoint.debugRuntime();
  }
  if (command === 'daemon_restart_status') return daemonRestart.status(args.restartId);
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

async function dispatchCommand(app: App, owner: string, command: CommandName, args: any): Promise<any> {
  app.clients.ensureOpen();
  if (args.hostId !== undefined && args.hostId !== 'local') throw new Error('Requests for another host must go through the Piop daemon of that host');
  if (typeof args.runtimeId === 'string') ensureRuntimeOwner(app.pi, args.runtimeId, owner);
  if (typeof args.terminalId === 'string') app.terminals.ensureOwner(args.terminalId, owner);
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command as keyof typeof COMMANDS] : undefined;
  if (!handler) throw new Error('Command is not available on the daemon: ' + command);
  const result = await handler(app, owner, args);
  return result === undefined ? null : result;
}

type Handlers = { [Name in CommandName]?: (app: App, owner: string, args: CommandArgs<Name>) => Promise<any> | any };

async function loadSettings(app: App, args: CommandArgs<'load_app_settings'>): Promise<any> {
  if (args.refreshSkills) refreshSkills();
  if (args.refreshTools) await discoverPi(app);
  return serializeAppSettings(await loadAppSettings(app));
}

// Saves the settings of this host, but keeps the client preferences that only its own clients change.
async function saveHostSettings(app: App, settings: AppSettings): Promise<any> {
  const previous = await loadAppSettings(app);
  settings.keybindings = previous.keybindings;
  settings.debugMode = previous.debugMode;
  return saveAppSettings(app, settings);
}

const COMMANDS: Handlers = {
  check_daemon_idle: async app => { await daemonRestart.ensureLocalIdle(app); return null; },
  plugin_status: app => localHost(app).host.pluginStatus(),
  plugin_client: (app, _owner, args) => localHost(app).host.pluginClient(args.id),
  shared_terminal: (app, owner, args) => terminalSessions.shared(app, owner, args),
  broker_request: (app, _owner, args) => clientBrokerRequest(app, args.path, args.body),
  save_host_settings: (app, _owner, args) => saveHostSettings(app, completeSettings(args.settings)),
  host_storage_report: async (_app, _owner, args) => ({ hosts: [await archives.inspectStorage(args.archivesOnly === true, args.archivesLimit)] }),
  submission_outcome: (app, _owner, args) => localHost(app).host.submissionOutcome(args.submissionId),
  provider_auth: (app, owner, args) => providerAuth.forOwner(app, owner, args.request),
  open_project_directory: async (_app, _owner, args) => { await openProjectDirectory(args.cwd); return null; },
  start_pi: async (app, owner, args) => {
    const result = await startPiForOwner(app, owner, app.pi, app.broker, args);
    result.daemonId = endpoint.identity();
    return result;
  },
  stop_pi: (app, _owner, args) => {
    if (args.preserveRunning === true) return detachPiWith(app.pi, args.runtimeId, false, true);
    return stopPi(app.pi, args.runtimeId, args.discardBlank);
  },
  pi_command: (app, _owner, args) => piCommand(app, app.pi, app.broker, args.runtimeId, args.command),
  pi_presence: async (app, _owner, args) => { await piPresence(app.pi, args.runtimeId, args.presence); return null; },
  start_terminal: async (app, owner, args) => {
    await startTerminalForOwner(app, owner, app.terminals, { terminalId: args.terminalId, sessionKey: args.sessionKey, cwd: args.cwd, cols: args.cols, rows: args.rows });
    if (app.clients.closing()) {
      await closeTerminal(app.terminals, args.terminalId);
      app.clients.ensureOpen();
    }
    return null;
  },
  write_terminal: (app, _owner, args) => { writeTerminal(app.terminals, args.terminalId, args.data); return null; },
  resize_terminal: (app, _owner, args) => { resizeTerminal(app.terminals, args.terminalId, args.cols, args.rows); return null; },
  close_terminal: async (app, _owner, args) => { await closeTerminal(app.terminals, args.terminalId); return null; },
  list_sessions: async app => (await sessionIndex.listSessions(app, app.sessionIndex)).map(serializeSession),
  session_ids: () => Registry.ids(profileRoot()),
  load_session_groups: async (app, _owner, args) => sessionGroups.serializeGroups(await sessionGroups.loadSessionGroups(app, args.seeds)),
  change_session_groups: async (app, _owner, args) => sessionGroups.serializeGroups(await sessionGroups.changeSessionGroups(app, args.change)),
  home_directory: () => sessionIndex.homeDirectory(),
  create_temporary_chat: () => sessionIndex.createTemporaryChat(),
  remove_temporary_chat: async (_app, _owner, args) => { await sessionIndex.removeTemporaryChat(args.path); return null; },
  new_chat_branches: (_app, _owner, args) => newChatBranches(args.path),
  validate_project_directory: (_app, _owner, args) => sessionIndex.validateProjectDirectory(args.path, args.allowStorage, args.newChat),
  list_directories: (app, _owner, args) => sessionIndex.listDirectories(app, 'local', args.path),
  read_image_file: (_app, _owner, args) => projectFiles.readImage(args.cwd, args.path),
  archive_session: async (app, owner, args) => {
    const terminalIds = args.terminalIds.filter(id => app.terminals.ownedByConnection(id, owner));
    await archives.archiveSession(app, app.terminals, args.sessionPath, terminalIds, args.clientId);
    return null;
  },
  delete_session: (app, _owner, args) => archives.deleteSession(app, app.pi, args.sessionPath, args.clientId),
  delete_archived_session: (app, _owner, args) => archives.deleteArchivedSession(app, app.pi, args.sessionPath, args.sessionPaths, args.clientId),
  restore_archived_session: async (app, _owner, args) => { await archives.restoreArchivedSession(app, args.sessionPath, args.clientId); return null; },
  relocate_session: async (app, _owner, args) => { await archives.relocateSession(app, args.sessionPath, args.cwd, args.clientId); return null; },
  recover_missing_session: (app, _owner, args) => archives.recoverMissingSession(app, args.sessionPath, args.action, args.clientId),
  load_app_settings: (app, _owner, args) => loadSettings(app, args),
  load_settings_change: app => loadSettingsChange(app),
  settings_pending_count: app => app.pi.settingsPendingSessions.size,
  save_app_settings: (app, _owner, args) => saveAppSettings(app, completeSettings(args.settings)),
  save_agent_definitions: (app, _owner, args) => localHost(app).host.saveAgents(args.configuration, args.cwd || undefined),
  agent_prompt_preview: async (app, _owner, args) => {
    const settings = await loadAppSettings(app);
    const spec = launchSpec(await buildPiCommand(settings, { kind: 'prompt-preview', cwd: args.cwd ?? '~' }));
    return localHost(app).host.previewAgentPrompt(spec, args.agent);
  },
  move_agent: (app, _owner, args) => localHost(app).host.moveAgentDefinition(args.agent, args.revision, args.from ?? null, args.to ?? null),
  provider_usage: (app, _owner, args) => {
    if (args.provider !== undefined && !isUsageProvider(args.provider)) throw new Error('Invalid provider: unknown usage provider ' + JSON.stringify(args.provider));
    return args.refresh ? app.usage.refresh(app, args.provider) : app.usage.snapshot();
  },
};
