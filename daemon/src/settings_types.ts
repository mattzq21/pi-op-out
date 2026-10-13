import reviewPrompt from '../resources/session-broker/review-prompt.txt?raw';
import { defaultKeybindings } from './keybindings';
import { capRangeError } from '../../extensions/piop-context-window-cap/interface';

export interface RemoteHost {
  enabled: boolean;
  id: string;
  name: string;
  target: string;
  piPath: string;
}

export interface AppSettings {
  settingsRevision?: string;
  reviewAgent: string;
  reviewPrompt: string;
  localEnabled: boolean;
  defaultAgent: string;
  defaultModel: string;
  hiddenModels: string[];
  knownModels?: string[];
  defaultThinking: string;
  defaultFastMode: boolean;
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
  /** Context caps by provider/model. A missing model inherits; null selects the model default. */
  modelContextWindowCaps: Record<string, number | null>;
  autoRetry: boolean;
  debugMode: boolean;
  keybindings: Record<string, string>;
  tools: ToolConfig[];
  skills: SkillConfig[];
  hosts: RemoteHost[];
}

export interface ToolConfig { name: string; description: string; enabled: boolean; builtin?: boolean }
export interface SkillConfig { name: string; path: string; description: string; enabled: boolean; userInvokedOnly?: boolean }

export const MAX_REMOTE_HOSTS = 16;

export function defaultAgent(): string { return 'general'; }
export function defaultReviewPrompt(): string { return reviewPrompt.trim(); }

function fail(field: string, expected: string): never { throw new Error(`invalid type for ${field}: expected ${expected}`); }

function stringField(value: any, field: string, fallback?: () => string): string {
  if (value === undefined) { if (fallback) return fallback(); throw new Error(`missing field \`${field}\``); }
  if (typeof value !== 'string') fail(field, 'a string');
  return value;
}

function boolField(value: any, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(field, 'a boolean');
  return value;
}

function optionalString(value: any, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(field, 'a string');
  return value;
}

function stringArray(value: any, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(field, 'a sequence of strings');
  return [...value];
}

function arrayField(value: any, field: string): any[] {
  if (value === undefined) throw new Error(`missing field \`${field}\``);
  if (!Array.isArray(value)) fail(field, 'a sequence');
  return value;
}

function entryFields(value: any, field: string, strings: string[], booleans: string[], optionalBooleans: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'a sequence of maps');
  for (const key of strings) if (typeof value[key] !== 'string') fail(`${field}.${key}`, 'a string');
  for (const key of booleans) if (typeof value[key] !== 'boolean') fail(`${field}.${key}`, 'a boolean');
  for (const key of optionalBooleans) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${field}.${key}`, 'a boolean');
}

function toolConfig(value: any): ToolConfig {
  entryFields(value, 'tools', ['name', 'description'], ['enabled'], ['builtin']);
  return value;
}

function skillConfig(value: any): SkillConfig {
  entryFields(value, 'skills', ['name', 'path', 'description'], ['enabled'], ['userInvokedOnly']);
  return value;
}

export function parseRemoteHost(value: any): RemoteHost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('hosts', 'a map');
  return {
    enabled: boolField(value.enabled, 'enabled', true),
    id: stringField(value.id, 'id'),
    name: stringField(value.name, 'name'),
    target: stringField(value.target, 'target'),
    piPath: stringField(value.piPath, 'piPath', () => 'pi'),
  };
}

function modelCaps(value: any): Record<string, number | null> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('modelContextWindowCaps', 'a map');
  const caps: Record<string, number | null> = {};
  for (const [model, cap] of Object.entries(value)) {
    if (cap !== null && (typeof cap !== 'number' || !Number.isSafeInteger(cap))) fail('modelContextWindowCaps', 'whole numbers or null');
    caps[model] = cap as number | null;
  }
  return caps;
}

/** Throws when a saved context cap is outside the accepted range. */
export function validateContextCaps(settings: AppSettings): void {
  const error = capRangeError(settings.contextWindowCap, 'General context cap');
  if (error) throw new Error(error);
  for (const [model, cap] of Object.entries(settings.modelContextWindowCaps)) {
    if (!model.includes('/')) throw new Error(`Context cap model "${model}" must be written as provider/model`);
    const capError = cap === null ? undefined : capRangeError(cap, `Context cap for ${model}`);
    if (capError) throw new Error(capError);
  }
}

/** Parses settings with the same defaults and required fields as the saved settings format. */
export function parseAppSettings(value: any): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid type: expected struct AppSettings');
  let contextWindowCap = 300_000;
  if (value.contextWindowCap !== undefined) {
    if (typeof value.contextWindowCap !== 'number' || !Number.isInteger(value.contextWindowCap) || value.contextWindowCap < 0) throw new Error('Context window cap must be a whole number');
    contextWindowCap = value.contextWindowCap;
  }
  let keybindings = defaultKeybindings();
  if (value.keybindings !== undefined) {
    if (!value.keybindings || typeof value.keybindings !== 'object' || Array.isArray(value.keybindings)) fail('keybindings', 'a map');
    keybindings = {};
    for (const [key, shortcut] of Object.entries(value.keybindings)) { if (typeof shortcut !== 'string') fail('keybindings', 'a string'); keybindings[key] = shortcut; }
  }
  const settings: AppSettings = {
    settingsRevision: optionalString(value.settingsRevision, 'settingsRevision'),
    reviewAgent: stringField(value.reviewAgent, 'reviewAgent', defaultAgent),
    reviewPrompt: stringField(value.reviewPrompt, 'reviewPrompt', defaultReviewPrompt),
    localEnabled: boolField(value.localEnabled, 'localEnabled', true),
    defaultAgent: stringField(value.defaultAgent, 'defaultAgent', defaultAgent),
    defaultModel: stringField(value.defaultModel, 'defaultModel'),
    hiddenModels: value.hiddenModels === undefined ? [] : stringArray(value.hiddenModels, 'hiddenModels'),
    knownModels: value.knownModels === undefined || value.knownModels === null ? undefined : stringArray(value.knownModels, 'knownModels'),
    defaultThinking: stringField(value.defaultThinking, 'defaultThinking'),
    defaultFastMode: boolField(value.defaultFastMode, 'defaultFastMode', false),
    contextWindowCap,
    contextWindowCapEnabled: boolField(value.contextWindowCapEnabled, 'contextWindowCapEnabled', true),
    modelContextWindowCaps: modelCaps(value.modelContextWindowCaps),
    autoRetry: boolField(value.autoRetry, 'autoRetry', true),
    debugMode: boolField(value.debugMode, 'debugMode', false),
    keybindings,
    tools: arrayField(value.tools, 'tools').map(toolConfig),
    skills: arrayField(value.skills, 'skills').map(skillConfig),
    hosts: value.hosts === undefined ? [] : arrayField(value.hosts, 'hosts').map(parseRemoteHost),
  };
  return settings;
}

/** Serializes settings in the saved field order, leaving out absent optional fields. */
export function serializeAppSettings(settings: AppSettings): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (settings.settingsRevision !== undefined) result.settingsRevision = settings.settingsRevision;
  result.reviewAgent = settings.reviewAgent;
  result.reviewPrompt = settings.reviewPrompt;
  result.localEnabled = settings.localEnabled;
  result.defaultAgent = settings.defaultAgent;
  result.defaultModel = settings.defaultModel;
  result.hiddenModels = settings.hiddenModels;
  if (settings.knownModels !== undefined) result.knownModels = settings.knownModels;
  result.defaultThinking = settings.defaultThinking;
  result.defaultFastMode = settings.defaultFastMode;
  result.contextWindowCap = settings.contextWindowCap;
  result.contextWindowCapEnabled = settings.contextWindowCapEnabled;
  result.modelContextWindowCaps = settings.modelContextWindowCaps;
  result.autoRetry = settings.autoRetry;
  result.debugMode = settings.debugMode;
  result.keybindings = settings.keybindings;
  result.tools = settings.tools;
  result.skills = settings.skills;
  result.hosts = settings.hosts.map(host => ({ enabled: host.enabled, id: host.id, name: host.name, target: host.target, piPath: host.piPath }));
  return result;
}

export function cloneSettings(settings: AppSettings): AppSettings {
  return parseAppSettings(JSON.parse(JSON.stringify(serializeAppSettings(settings))));
}

export function defaultSettings(): AppSettings {
  return {
    reviewAgent: defaultAgent(),
    reviewPrompt: defaultReviewPrompt(),
    localEnabled: true,
    defaultAgent: defaultAgent(),
    defaultFastMode: false,
    defaultModel: '',
    hiddenModels: [],
    defaultThinking: 'medium',
    contextWindowCap: 300_000,
    contextWindowCapEnabled: true,
    modelContextWindowCaps: {},
    autoRetry: true,
    debugMode: false,
    keybindings: defaultKeybindings(),
    tools: [
      ...['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].map(name => ({ name, description: 'Pi built-in tool', enabled: true, builtin: true })),
      { name: 'list_agents', description: 'List child agents and their status', enabled: true, builtin: false },
      { name: 'send_message', description: 'Deliver an agent mailbox message', enabled: true, builtin: false },
      codexWebSearchTool(),
    ],
    skills: [],
    hosts: [],
  };
}

export function sessionOperationTools(): any[] {
  return ([
    ['subagent', 'Delegate parallel tasks to agents with saved transcripts'],
    ['request_user_input', 'Ask the user questions with choices and free-text answers'],
    ['render_html', 'Display self-contained HTML previews in chat'],
    ['get_goal', 'Read the current persistent goal'],
    ['create_goal', 'Create a persistent goal with an optional token budget'],
    ['update_goal', 'Complete, block or pause the current goal'],
  ] as const).map(([name, description]) => ({ name, description, enabled: true, builtin: false }));
}

export function codexWebSearchTool(): any {
  return { name: 'web_search', description: "Search the web with Pi's Codex login and return cited answers", enabled: true, builtin: false };
}

export function validateRemoteHost(host: RemoteHost): void {
  if (!host.target || !/^[A-Za-z0-9._@:\-\[\]]+$/.test(host.target)) throw new Error('SSH target may only contain a host, user, and port-safe characters');
  if (!host.piPath || !/^[A-Za-z0-9._\/\-~]+$/.test(host.piPath)) throw new Error('Pi executable must be a plain executable name or path');
}
