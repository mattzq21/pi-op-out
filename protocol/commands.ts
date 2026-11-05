import { z } from "zod";
import { appSettingsSchema, settingsChangeSchema } from "./settings";
import { groupChangeSchema, sessionGroupsSchema, sessionSeedSchema } from "./session-groups";
import { pluginStatusSchema } from "./plugins";
import {
  directoryListingSchema, promptPreviewSchema, providerUsageSchema, savedAgentsSchema, sessionSummarySchema,
  startedPiSchema, storageReportSchema, submissionOutcomeSchema,
} from "./results";

// The commands that clients send to a daemon: what each takes, and what it answers. Both the daemon and the clients
// use this table, so a command is defined only here.
//
// hostId: the host the command is for. Absent or "local" means the daemon that gets it; the daemon sends other
//   commands on to that host.
// clientId: the client that sends the command. Clients add it to each command.
// local: the command is about the daemon that gets it, and is never sent on to another host.
// opens, closes: the command starts or stops the resource that the argument of this name identifies. A resource is a
//   chat runtime or a terminal: it stays on its host until it is stopped, or until the client that started it goes.
// control: the command stops work. It runs even when all work slots of the daemon are busy.

const base = z.object({ hostId: z.string().optional(), clientId: z.string().optional() });
const args = <Shape extends z.ZodRawShape>(shape: Shape) => base.extend(shape);
const none = z.unknown().transform((): null => null);
// Any value; a missing key fails. maybeAnything also accepts a missing key.
const anything = z.unknown();
const maybeAnything = z.unknown().optional();
const nullableText = z.string().nullish();

export type ResourceKind = "runtimeId" | "terminalId";

interface Command { args: z.ZodType; result: z.ZodType; local?: true; opens?: ResourceKind; closes?: ResourceKind; control?: (args: any) => boolean }

const always = () => true;

export const COMMANDS = {
  // Settings
  load_app_settings: { args: args({ refreshSkills: z.boolean().optional(), refreshTools: z.boolean().optional() }), result: appSettingsSchema },
  load_settings_change: { args: args({}), result: settingsChangeSchema },
  // Saves all settings of this daemon, including the client preferences that it keeps.
  save_app_settings: { args: args({ settings: appSettingsSchema }), result: settingsChangeSchema, local: true },
  // Saves the settings of a host, but keeps its own client preferences.
  save_host_settings: { args: args({ settings: appSettingsSchema }), result: settingsChangeSchema },
  settings_pending_count: { args: args({}), result: z.number().int().nonnegative(), local: true },
  plugin_status: { args: args({}), result: pluginStatusSchema },
  // The client part of an enabled plugin: its client.mjs.
  plugin_client: { args: args({ id: z.string() }), result: z.object({ source: z.string() }) },
  restart_daemon: {
    args: args({ enabled: z.array(z.string()), revision: z.string(), closeTerminals: z.boolean().optional() }),
    result: z.union([z.object({ restartId: z.string() }), z.object({ confirmationRequired: z.literal("terminals"), terminalCount: z.number() })]),
  },
  daemon_restart_status: { args: args({ restartId: z.string() }), result: z.object({ phase: z.string(), error: z.string().nullable() }).loose() },
  check_daemon_idle: { args: args({}), result: none },
  provider_usage: { args: args({ provider: z.string().optional(), refresh: z.boolean().optional() }), result: providerUsageSchema },

  // Agents and providers. The requests of provider_auth and the commands of pi_command have their own protocols.
  provider_auth: { args: args({ request: anything, flowId: z.string().optional() }), result: anything, control: (args: any) => args.request?.action === "cancel" },
  save_agent_definitions: { args: args({ configuration: anything, cwd: z.string().optional() }), result: savedAgentsSchema },
  agent_prompt_preview: { args: args({ agent: z.string(), cwd: z.string().optional() }), result: promptPreviewSchema },
  move_agent: { args: args({ agent: z.string(), revision: z.string(), from: nullableText, to: nullableText }), result: savedAgentsSchema },
  broker_request: { args: args({ path: z.string(), body: maybeAnything }), result: anything },
  submission_outcome: { args: args({ submissionId: z.string() }), result: submissionOutcomeSchema },

  // Chats
  start_pi: {
    args: args({
      clientId: z.string(), runtimeId: z.string(), cwd: nullableText, sessionPath: nullableText, sessionId: nullableText, forkPath: nullableText,
      baseBranch: z.string().optional(), presence: maybeAnything,
    }),
    result: startedPiSchema,
    opens: "runtimeId",
  },
  stop_pi: { args: args({ runtimeId: z.string(), discardBlank: z.boolean().optional(), preserveRunning: z.boolean().optional() }), result: z.boolean(), closes: "runtimeId", control: always },
  pi_command: { args: args({ runtimeId: z.string(), command: anything }), result: anything, control: (args: any) => args.command?.type === "abort" },
  pi_presence: { args: args({ runtimeId: z.string(), presence: maybeAnything }), result: none },
  list_sessions: { args: args({}), result: z.array(sessionSummarySchema) },
  session_ids: { args: args({}), result: z.array(z.string()) },
  create_temporary_chat: { args: args({}), result: z.object({ cwd: z.string(), sessionId: z.string() }) },
  remove_temporary_chat: { args: args({ path: z.string() }), result: none },
  archive_session: { args: args({ clientId: z.string(), sessionId: z.string(), terminalIds: z.array(z.string()) }), result: none },
  delete_sessions: { args: args({ clientId: z.string(), sessionIds: z.array(z.string()).min(1) }), result: z.array(z.string()) },
  restore_session: { args: args({ clientId: z.string(), sessionId: z.string() }), result: none },
  relocate_session: { args: args({ clientId: z.string(), sessionPath: z.string(), cwd: z.string() }), result: none },
  recover_missing_session: { args: args({ clientId: z.string(), sessionPath: z.string(), action: z.string() }), result: z.object({ cwd: z.string(), warnings: z.array(z.string()) }) },
  storage_report: { args: args({ archivesOnly: z.boolean().optional() }), result: storageReportSchema },
  host_storage_report: { args: args({ archivesOnly: z.boolean().optional(), archivesLimit: z.number().optional() }), result: storageReportSchema },
  load_session_groups: { args: args({ seeds: z.array(sessionSeedSchema) }), result: sessionGroupsSchema, local: true },
  change_session_groups: { args: args({ change: groupChangeSchema }), result: sessionGroupsSchema, local: true },

  // Folders and files
  home_directory: { args: args({}), result: z.string() },
  new_chat_branches: { args: args({ path: z.string() }), result: z.object({ repository: z.string(), branches: z.array(z.string()), defaultBranch: z.string().nullable() }).nullable() },
  validate_project_directory: { args: args({ path: z.string(), allowStorage: z.boolean().optional(), newChat: z.boolean().optional() }), result: z.string() },
  list_directories: { args: args({ path: z.string().optional() }), result: directoryListingSchema },
  open_project_directory: { args: args({ cwd: z.string() }), result: none },
  read_image_file: { args: args({ cwd: z.string(), path: z.string() }), result: z.string().regex(/^data:image\/(png|jpeg|gif|webp);base64,/) },

  // Terminals. shared_terminal has its own actions; its list action answers sharedTerminalsSchema.
  start_terminal: { args: args({ terminalId: z.string(), sessionKey: z.string(), cwd: z.string(), cols: z.number(), rows: z.number() }), result: none, opens: "terminalId" },
  write_terminal: { args: args({ terminalId: z.string(), data: z.string() }), result: none },
  resize_terminal: { args: args({ terminalId: z.string(), cols: z.number(), rows: z.number() }), result: none },
  close_terminal: { args: args({ terminalId: z.string() }), result: none, closes: "terminalId", control: always },
  shared_terminal: {
    args: args({
      action: z.string(), sharedTerminalId: z.string().optional(), sessionKey: z.string().optional(), cwd: z.string().optional(), data: z.string().optional(),
      expectedDraft: z.string().optional(), known: z.record(z.string(), z.object({ generation: z.string(), outputEnd: z.number() })).optional(),
      cols: z.number().optional(), rows: z.number().optional(), terminalConnectionId: z.string().optional(),
    }),
    result: anything,
    control: (args: any) => args.action === "discard_drafts",
  },

  debug_runtime: { args: args({}), result: anything, local: true },
} satisfies Record<string, Command>;

export type CommandName = keyof typeof COMMANDS;
export type CommandArgs<Name extends CommandName> = z.output<typeof COMMANDS[Name]["args"]>;
// What a client gives for a command. The client transport adds the clientId.
export type CommandInput<Name extends CommandName> = Omit<z.input<typeof COMMANDS[Name]["args"]>, "clientId">;
export type CommandResult<Name extends CommandName> = z.output<typeof COMMANDS[Name]["result"]>;

// The commands whose requests and answers have their own protocols: Pi's commands, provider sign-in, the broker and
// the shared terminal actions. Clients check their answers with the schema of that protocol.
export type InnerProtocolCommand = "pi_command" | "provider_auth" | "broker_request" | "shared_terminal";

export function isCommand(name: string): name is CommandName { return Object.hasOwn(COMMANDS, name); }

// True when the command is about the daemon that gets it and is never sent on to another host.
export function localCommand(name: CommandName): boolean { return "local" in COMMANDS[name]; }

const table: Record<CommandName, Command> = COMMANDS;

// The resource that the command starts or stops, if any.
export function opens(name: CommandName): ResourceKind | undefined { return table[name].opens; }
export function closes(name: CommandName): ResourceKind | undefined { return table[name].closes; }

// The command that stops a resource of this kind.
export function closer(kind: ResourceKind): CommandName {
  const name = (Object.keys(table) as CommandName[]).find(name => table[name].closes === kind);
  if (!name) throw new Error("No command stops a " + kind);
  return name;
}

// True when the request stops work, so it may run when all work slots are busy. The arguments are not checked yet.
export function controlRequest(name: string, args: unknown): boolean {
  if (!isCommand(name)) return false;
  const control = table[name].control;
  return control !== undefined && args !== null && typeof args === "object" && control(args);
}

// The arguments of a command, checked. Fails with what is wrong in them.
export function commandArgs<Name extends CommandName>(name: Name, value: unknown): CommandArgs<Name> {
  const parsed = COMMANDS[name].args.safeParse(value ?? {});
  if (!parsed.success) throw new Error(`Invalid ${name} request: ${z.prettifyError(parsed.error)}`);
  return parsed.data as CommandArgs<Name>;
}
